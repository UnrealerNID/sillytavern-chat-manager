import {
    buildRanges,
    chatKey,
    cloneJson,
    digestMessages,
    formatBytes,
    jsonlByteSize,
    stripJsonl,
} from '../shared/utils.js';
import {
    fingerprintsEqual,
    getSourceFingerprint,
    loadStableSource,
} from './source.js';

export class SplitService {
    /**
     * @param {import('../platform/api.js').ChatManagerApi} api 接口实例
     * @param {import('./task-journal.js').TaskJournal} journal 任务日志
     * @param {()=>string} uuid UUID 提供器
     */
    constructor(api, journal, uuid) {
        this.api = api;
        this.journal = journal;
        this.uuid = uuid;
        this.running = false;
        this.stopRequested = false;
    }

    /**
     * 请求在当前分卷保存完成后暂停任务
     */
    requestStop() {
        this.stopRequested = true;
    }

    /**
     * 创建只读分割计划
     * @param {object} record 聊天记录
     * @param {object} options 分割参数
     * @param {'range'|'fixed'} options.mode 分割方式
     * @param {number} options.start 起始楼层
     * @param {number} options.end 结束楼层
     * @param {number} [options.chunkSize] 每卷楼层数
     * @param {boolean} [options.incremental] 是否增量分卷
     * @param {number} [options.sequenceStart] 起始卷号
     * @param {string} [options.outputRootChatId] 分卷组根标识
     * @param {number} [options.rangeOffset] 楼层偏移
     * @param {AbortSignal} [signal] 取消信号
     * @param {object} [stableSource] 已读取并校验过的来源快照
     * @returns {Promise<object>} 分割计划
     */
    async prepare(record, options, signal, stableSource = null) {
        if (this.running) throw new Error('已有分割任务正在运行');
        const source = stableSource ?? await loadStableSource(record, this.api, signal);
        if (source.messages.length === 0) throw new Error('空聊天不能分割');
        const ranges = buildRanges(options.start, options.end, options.mode === 'fixed' ? options.chunkSize : null);
        if (options.end >= source.messages.length) throw new Error('楼层范围超出聊天长度');
        const occupied = await this.#occupiedNames(record);
        const reserved = new Set();
        const parts = [];
        const sequenceStart = Number(options.sequenceStart ?? 1);
        const rangeOffset = Number(options.rangeOffset ?? 0);
        const outputRootChatId = String(options.outputRootChatId ?? record.fileId);
        const chunkSize = options.mode === 'fixed' ? options.chunkSize : null;

        for (let index = 0; index < ranges.length; index++) {
            const range = ranges[index];
            const logicalRange = { ...range, start: range.start + rangeOffset, end: range.end + rangeOffset };
            const sequence = sequenceStart + index;
            // 楼层范围和分卷配置已写入聊天头，文件名只保留便于辨认的顺序号
            const suffix = ` - ${sequence}`;
            const fileId = await this.#uniqueName(record, suffix, occupied, reserved, outputRootChatId);
            reserved.add(fileId);
            const messages = source.messages.slice(range.start, range.end + 1);
            const digest = await digestMessages(messages);
            const integrity = this.uuid();
            const header = this.#makeHeader(source.header, record, logicalRange, digest, integrity, {
                mode: options.mode,
                chunkSize,
                sequence,
                incremental: Boolean(options.incremental),
                rootChatId: outputRootChatId,
            });
            parts.push({
                ...logicalRange,
                sourceStart: range.start,
                sourceEnd: range.end,
                fileId,
                messages,
                header,
                splitConfig: {
                    mode: options.mode,
                    chunkSize,
                    sequence,
                    incremental: Boolean(options.incremental),
                    rootChatId: outputRootChatId,
                },
                digest,
                integrity,
                estimatedBytes: jsonlByteSize(header, messages),
            });
        }

        return {
            id: this.uuid(),
            record: cloneJson(record),
            options: cloneJson(options),
            fingerprint: source.fingerprint,
            source,
            parts,
            createdAt: new Date().toISOString(),
        };
    }

    /**
     * 串行执行已确认的分割计划
     * @param {object} plan 分割计划
     * @param {object} options 执行参数
     * @param {()=>boolean} [options.shouldPause] 是否暂停任务
     * @param {(task:object)=>void} [options.onUpdate] 任务进度回调
     * @param {object} [options.resumeTask] 待恢复任务
     * @param {boolean} [options.lockAcquired] 是否已取得浏览器锁
     * @returns {Promise<object>} 任务结果
     */
    async execute(plan, options = {}) {
        if (this.running) throw new Error('已有分割任务正在运行');
        if (!options.lockAcquired && globalThis.navigator?.locks?.request) {
            const lockName = `sillytavern-chat-manager:${plan.record.ownerType}:${plan.record.ownerId}`;
            return navigator.locks.request(lockName, { mode: 'exclusive' }, () => this.execute(plan, { ...options, lockAcquired: true }));
        }
        const current = await getSourceFingerprint(plan.record, this.api);
        if (!fingerprintsEqual(plan.fingerprint, current)) throw new Error('原聊天在预览后发生变化，正在重新读取并更新预览');
        this.running = true;
        this.stopRequested = false;
        const task = options.resumeTask ?? this.#taskFromPlan(plan);
        await this.journal.put(task);
        try {
            for (let index = 0; index < plan.parts.length; index++) {
                const part = plan.parts[index];
                const state = task.parts[index];
                if (state.status === 'complete') continue;
                if (this.stopRequested || options.shouldPause?.()) {
                    task.status = 'paused';
                    await this.journal.put(task);
                    options.onUpdate?.(task);
                    return task;
                }
                if (state.status === 'unregistered' || state.status === 'verified') {
                    if (plan.record.ownerType === 'group') await this.#registerGroup(plan.record.ownerId, part.fileId);
                    state.status = 'complete';
                    await this.journal.put(task);
                    options.onUpdate?.(task);
                    continue;
                }
                if (await this.#nameExists(plan.record, part.fileId)) {
                    throw new Error(`目标名称已被占用：${part.fileId}`);
                }
                state.status = 'writing';
                await this.journal.put(task);
                options.onUpdate?.(task);
                try {
                    await this.#save(plan.record, part);
                } catch (error) {
                    if (!await this.#verify(plan.record, part)) throw error;
                }
                if (!await this.#verify(plan.record, part)) throw new Error(`分卷回读校验失败：${part.fileId}`);
                state.status = 'verified';
                await this.journal.put(task);
                if (plan.record.ownerType === 'group') {
                    try {
                        await this.#registerGroup(plan.record.ownerId, part.fileId);
                    } catch (error) {
                        state.status = 'unregistered';
                        state.error = error.message;
                        task.status = 'partial';
                        await this.journal.put(task);
                        options.onUpdate?.(task);
                        throw error;
                    }
                }
                state.status = 'complete';
                state.error = null;
                await this.journal.put(task);
                options.onUpdate?.(task);
            }
            task.status = 'complete';
            await this.journal.put(task);
            options.onUpdate?.(task);
            await this.journal.remove(task.id);
            return task;
        } catch (error) {
            task.status = 'partial';
            task.error = error.message;
            await this.journal.put(task);
            options.onUpdate?.(task);
            error.task = task;
            throw error;
        } finally {
            this.running = false;
            this.stopRequested = false;
        }
    }

    /**
     * 只读核对未完成的任务日志
     * @returns {Promise<object[]>} 核对后的任务
     */
    async reconcile() {
        const tasks = (await this.journal.list()).filter(task => task.status !== 'complete');
        for (const task of tasks) {
            for (const part of task.parts) {
                if (!['writing', 'verified', 'unregistered', 'complete'].includes(part.status)) continue;
                const pseudoPart = { fileId: part.fileId, digest: part.digest, count: part.count };
                const verified = await this.#verify(task.record, pseudoPart).catch(() => false);
                if (!verified) {
                    part.status = 'unknown';
                    continue;
                }
                if (task.record.ownerType === 'group') {
                    const groups = await this.api.getGroups();
                    const group = Array.isArray(groups) && groups.find(item => String(item.id) === String(task.record.ownerId));
                    part.status = group?.chats?.includes(part.fileId) ? 'complete' : 'unregistered';
                } else {
                    part.status = 'complete';
                }
            }
            await this.journal.put(task);
        }
        return tasks;
    }

    /**
     * 根据任务日志重建可恢复计划
     * @param {object} task 日志任务
     * @returns {Promise<object>} 分割计划
     */
    async restorePlan(task) {
        const source = await loadStableSource(task.record, this.api);
        if (!fingerprintsEqual(task.fingerprint, source.fingerprint)) throw new Error('原聊天已变化，不能继续旧任务');
        const parts = [];
        for (const saved of task.parts) {
            const sourceStart = saved.sourceStart ?? saved.start;
            const sourceEnd = saved.sourceEnd ?? saved.end;
            const messages = source.messages.slice(sourceStart, sourceEnd + 1);
            const digest = await digestMessages(messages);
            if (digest !== saved.digest) throw new Error(`来源范围摘要已变化：${saved.fileId}`);
            const range = { start: saved.start, end: saved.end, count: saved.count };
            parts.push({
                ...range,
                sourceStart,
                sourceEnd,
                fileId: saved.fileId,
                digest,
                integrity: saved.integrity,
                messages,
                header: this.#makeHeader(source.header, task.record, range, digest, saved.integrity, saved.splitConfig),
                splitConfig: saved.splitConfig,
            });
        }
        return { id: task.id, record: task.record, fingerprint: task.fingerprint, source, parts };
    }

    #taskFromPlan(plan) {
        return {
            id: plan.id,
            status: 'running',
            createdAt: plan.createdAt,
            record: plan.record,
            fingerprint: plan.fingerprint,
            parts: plan.parts.map(part => ({
                fileId: part.fileId,
                start: part.start,
                end: part.end,
                sourceStart: part.sourceStart,
                sourceEnd: part.sourceEnd,
                count: part.count,
                digest: part.digest,
                integrity: part.integrity,
                splitConfig: part.splitConfig,
                status: 'planned',
                error: null,
            })),
        };
    }

    #makeHeader(sourceHeader, record, range, digest, integrity, splitConfig = {}) {
        const header = cloneJson(sourceHeader);
        const metadata = cloneJson(header.chat_metadata ?? {});
        const previous = metadata.chat_manager;
        delete metadata.integrity;
        delete metadata.main_chat;
        delete metadata.chat_id_hash;
        delete metadata.lastInContextMessageId;
        metadata.integrity = integrity;
        metadata.chat_manager = {
            schema: 1,
            sourceChatId: record.fileId,
            rootChatId: splitConfig.rootChatId ?? previous?.rootChatId ?? previous?.sourceChatId ?? record.fileId,
            sourceIntegrity: sourceHeader.chat_metadata?.integrity ?? null,
            sourceStart: range.start,
            sourceEnd: range.end,
            messageDigest: digest,
            splitMode: splitConfig.mode ?? null,
            chunkSize: splitConfig.chunkSize ?? null,
            sequence: splitConfig.sequence ?? null,
            incremental: Boolean(splitConfig.incremental),
            createdAt: new Date().toISOString(),
        };
        header.chat_metadata = metadata;
        header.user_name = 'unused';
        header.character_name = 'unused';
        return header;
    }

    async #occupiedNames(record) {
        if (record.ownerType === 'character') {
            const chats = await this.api.getCharacterChats(record.ownerId, { simple: true });
            if (!Array.isArray(chats)) throw new Error('无法读取角色聊天名称');
            return new Set(chats.map(item => stripJsonl(item.file_name)));
        }
        const contextGroups = this.api.getContext().groups;
        const group = contextGroups.find(item => String(item.id) === String(record.ownerId));
        return new Set(group?.chats ?? []);
    }

    async #uniqueName(record, suffix, occupied, reserved, baseFileId = record.fileId) {
        const codePoints = Array.from(baseFileId);
        for (let collision = 1; collision <= 9999; collision++) {
            const numeric = collision === 1 ? '' : `-${collision}`;
            const tail = `${suffix}${numeric}`;
            for (let length = codePoints.length; length >= 1; length--) {
                const full = await this.api.sanitizeFileName(`${codePoints.slice(0, length).join('')}${tail}.jsonl`);
                if (!full.toLowerCase().endsWith('.jsonl')) continue;
                const fileId = stripJsonl(full);
                if (!fileId.endsWith(tail)) continue;
                if (occupied.has(fileId) || reserved.has(fileId)) break;
                if (record.ownerType === 'group' && await this.api.groupChatExists(fileId)) break;
                return fileId;
            }
        }
        throw new Error('无法生成安全且不冲突的分卷名称');
    }

    async #nameExists(record, fileId) {
        if (record.ownerType === 'group') return this.api.groupChatExists(fileId);
        const chats = await this.api.getCharacterChats(record.ownerId, { simple: true });
        return Array.isArray(chats) && chats.some(item => stripJsonl(item.file_name) === fileId);
    }

    async #save(record, part) {
        const payload = [part.header, ...part.messages];
        if (record.ownerType === 'character') return this.api.saveCharacterChat(record.ownerId, part.fileId, payload);
        return this.api.saveGroupChat(part.fileId, payload);
    }

    async #verify(record, part) {
        const data = record.ownerType === 'character'
            ? await this.api.getCharacterChat(record.ownerId, part.fileId)
            : await this.api.getGroupChat(part.fileId);
        if (!Array.isArray(data) || data.length !== part.count + 1) return false;
        return await digestMessages(data.slice(1)) === part.digest;
    }

    async #registerGroup(groupId, fileId) {
        const groups = await this.api.getGroups();
        if (!Array.isArray(groups)) throw new Error('群组列表格式无效');
        const group = groups.find(item => String(item.id) === String(groupId));
        if (!group) throw new Error('目标群组已不存在');
        if (!Array.isArray(group.chats)) group.chats = [];
        if (!group.chats.includes(fileId)) {
            group.chats.push(fileId);
            await this.api.editGroup(group);
        }
        const refreshed = await this.api.getGroups();
        const saved = Array.isArray(refreshed) && refreshed.find(item => String(item.id) === String(groupId));
        if (!saved?.chats?.includes(fileId)) throw new Error(`群聊文件已创建但登记失败：${fileId}`);
    }
}

export function describePart(part) {
    return `${part.fileId}　#${part.start}-#${part.end}　${part.count} 层　${formatBytes(part.estimatedBytes ?? 0)}`;
}
