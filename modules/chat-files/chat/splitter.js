import {
    cloneJson,
    digestMessages,
    jsonlByteSize,
} from '../../shared/data.js';
import { formatBytes, stripJsonl } from '../../shared/files.js';
import { chatKey } from './identity.js';
import { buildRanges } from './ranges.js';
import {
    fingerprintsEqual,
    getSourceFingerprint,
    loadStableSource,
} from './source.js';

export class SplitService {
    /**
     * @param {import('../api.js').ChatManagerApi} api 接口实例
     * @param {import('./task-journal.js').TaskJournal} journal 任务日志
     * @param {()=>string} uuid UUID 提供器
     * @param {(record:object,nextFileId:string)=>Promise<boolean>} [renameRecord] 重命名聊天
     */
    constructor(api, journal, uuid, renameRecord = null) {
        this.api = api;
        this.journal = journal;
        this.uuid = uuid;
        this.renameRecord = renameRecord;
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
     * 创建只读分卷计划
     * @param {object} record 聊天记录
     * @param {object} options 分卷参数
     * @param {'range'|'fixed'} options.mode 分卷方式
     * @param {number} options.start 起始楼层
     * @param {number} options.end 结束楼层
     * @param {number} [options.chunkSize] 每卷楼层数
     * @param {boolean} [options.incremental] 是否增量分卷
     * @param {number} [options.sequenceStart] 起始卷号
     * @param {string} [options.outputRootChatId] 分卷组根标识
     * @param {number} [options.rangeOffset] 楼层偏移
     * @param {AbortSignal} [signal] 取消信号
     * @param {object} [stableSource] 已读取并校验过的来源快照
     * @returns {Promise<object>} 分卷计划
     */
    async prepare(record, options, signal, stableSource = null) {
        if (this.running) throw new Error('已有分卷任务正在运行');
        const source = stableSource ?? await loadStableSource(record, this.api, signal);
        if (source.messages.length === 0) throw new Error('空聊天不能分卷');
        const ranges = buildRanges(options.start, options.end, options.mode === 'fixed' ? options.chunkSize : null);
        if (options.end >= source.messages.length) throw new Error('楼层范围超出聊天长度');
        const occupied = await this.#occupiedNames(record);
        const reserved = new Set();
        let replacement = null;
        if (options.incremental) {
            const backupFileId = await this.#uniqueName(record, ' 备份', occupied, reserved);
            replacement = {
                originalFileId: record.fileId,
                backupFileId,
                status: 'planned',
            };
            reserved.add(backupFileId);
            occupied.delete(record.fileId);
        }
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
            const fileId = await this.#uniqueName(
                record,
                suffix,
                occupied,
                reserved,
                outputRootChatId,
                replacement?.originalFileId,
            );
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
                sourceChatId: replacement?.backupFileId,
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
                    sourceChatId: replacement?.backupFileId,
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
            replacement,
            createdAt: new Date().toISOString(),
        };
    }

    /**
     * 串行执行已确认的分卷计划
     * @param {object} plan 分卷计划
     * @param {object} options 执行参数
     * @param {(task:object)=>void} [options.onUpdate] 任务进度回调
     * @param {object} [options.resumeTask] 待恢复任务
     * @param {boolean} [options.lockAcquired] 是否已取得浏览器锁
     * @returns {Promise<object>} 任务结果
     */
    async execute(plan, options = {}) {
        if (this.running) throw new Error('已有分卷任务正在运行');
        if (!options.lockAcquired && globalThis.navigator?.locks?.request) {
            const lockName = `sillytavern-toolbox:${plan.record.ownerType}:${plan.record.ownerId}`;
            return navigator.locks.request(
                lockName,
                { mode: 'exclusive' },
                () => this.execute(plan, { ...options, lockAcquired: true }),
            );
        }
        const current = await getSourceFingerprint(plan.record, this.api);
        if (!fingerprintsEqual(plan.fingerprint, current)) {
            const error = new Error('原聊天在预览后发生变化，正在重新读取并更新预览');
            error.code = 'SOURCE_CHANGED';
            throw error;
        }
        this.running = true;
        this.stopRequested = false;
        const task = options.resumeTask ?? this.#taskFromPlan(plan);
        await this.journal.put(task);
        try {
            await this.#prepareReplacement(plan, task);
            for (let index = 0; index < plan.parts.length; index++) {
                const part = plan.parts[index];
                const state = task.parts[index];
                if (state.status === 'complete') continue;
                if (this.stopRequested) {
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
        const groupTasks = tasks.some(task => task.record.ownerType === 'group');
        const groups = groupTasks ? await this.api.getGroups() : [];
        const groupById = new Map((Array.isArray(groups) ? groups : [])
            .map(group => [String(group.id), group]));
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
                    const group = groupById.get(String(task.record.ownerId));
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
     * @returns {Promise<object>} 分卷计划
     */
    async restorePlan(task) {
        const record = await this.#resolveTaskRecord(task);
        const source = await loadStableSource(record, this.api);
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
                header: this.#makeHeader(
                    source.header,
                    record,
                    range,
                    digest,
                    saved.integrity,
                    saved.splitConfig,
                ),
                splitConfig: saved.splitConfig,
            });
        }
        task.record = record;
        return {
            id: task.id,
            record,
            fingerprint: task.fingerprint,
            source,
            parts,
            replacement: task.replacement ?? null,
        };
    }

    #taskFromPlan(plan) {
        return {
            id: plan.id,
            status: 'running',
            createdAt: plan.createdAt,
            record: plan.record,
            fingerprint: plan.fingerprint,
            replacement: plan.replacement,
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
            sourceChatId: splitConfig.sourceChatId ?? record.fileId,
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

    async #uniqueName(
        record,
        suffix,
        occupied,
        reserved,
        baseFileId = record.fileId,
        ignoredFileId = '',
    ) {
        const codePoints = Array.from(baseFileId);
        for (let collision = 1; collision <= 9999; collision++) {
            const numeric = collision === 1 ? '' : `-${collision}`;
            const tail = `${suffix}${numeric}`;
            for (let length = codePoints.length; length >= 1; length--) {
                const full = await this.api.sanitizeFileName(`${codePoints.slice(0, length).join('')}${tail}.jsonl`);
                if (!full.toLowerCase().endsWith('.jsonl')) continue;
                const fileId = stripJsonl(full);
                if (!fileId.endsWith(tail)) continue;
                if ((occupied.has(fileId) && fileId !== ignoredFileId) || reserved.has(fileId)) break;
                if (record.ownerType === 'group'
                    && fileId !== ignoredFileId
                    && await this.api.groupChatExists(fileId)) break;
                return fileId;
            }
        }
        throw new Error('无法生成安全且不冲突的分卷名称');
    }

    /**
     * 在写入替代分卷前把旧尾卷保留为来源备份
     * @param {object} plan 分卷计划
     * @param {object} task 任务日志
     */
    async #prepareReplacement(plan, task) {
        if (!plan.replacement || task.replacement?.status === 'complete') return;
        if (!this.renameRecord) throw new Error('当前环境不支持保留源分卷');
        const replacement = task.replacement ?? cloneJson(plan.replacement);
        const backupRecord = { ...plan.record, fileId: replacement.backupFileId };
        const [backupExists, originalExists] = await Promise.all([
            this.api.chatExists(backupRecord),
            this.api.chatExists(plan.record),
        ]);
        if (backupExists && originalExists) throw new Error('源分卷备份名称已被占用');
        if (!backupExists) {
            if (!originalExists) throw new Error('待保留的尾卷已不存在');
            const renamed = await this.renameRecord(plan.record, replacement.backupFileId);
            if (!renamed) throw new Error('无法把旧尾卷保留为源分卷');
        }
        replacement.status = 'complete';
        task.replacement = replacement;
        task.record = backupRecord;
        await this.journal.put(task);
    }

    /**
     * 从原文件或已完成重命名的来源备份恢复任务输入
     * @param {object} task 任务日志
     * @returns {Promise<object>} 当前可读取的来源聊天
     */
    async #resolveTaskRecord(task) {
        const replacement = task.replacement;
        if (!replacement) return task.record;
        const backupRecord = { ...task.record, fileId: replacement.backupFileId };
        if (await this.api.chatExists(backupRecord)) return backupRecord;
        return { ...task.record, fileId: replacement.originalFileId };
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
