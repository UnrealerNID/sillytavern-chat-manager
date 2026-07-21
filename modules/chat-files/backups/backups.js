import {
    digestMessage,
    parseJsonlResponse,
    toHex,
} from '../../shared/data.js';
import {
    formatBytes,
    stripJsonl,
} from '../../shared/files.js';
import { chatKey } from '../chat/identity.js';
import { loadStableSource } from '../chat/source.js';

const BACKUP_LIST_CACHE_MS = 30_000;
const MATCH_RESULT_CACHE_MS = 60_000;
const MATCH_CONCURRENCY = 4;

export class BackupService {
    /**
     * @param {import('../api.js').ChatManagerApi} api 接口实例
     */
    constructor(api) {
        this.api = api;
        this.backupListCache = null;
        this.backupListPromise = null;
        this.reportToken = '';
        // 同一状态对象同时记录读取计数、退休标记和释放任务，避免并行容器失步
        this.reportLeases = new Map();
        this.resultCache = new Map();
        this.catalogRevision = 0;
    }

    /**
     * 查找与指定聊天相关的备份
     * @param {object} record 聊天记录
     * @param {object} callbacks 扫描阶段回调
     * @param {(done:number,total:number)=>void} [callbacks.onProgress] 进度回调
     * @param {(candidates:object[])=>void} [callbacks.onCandidates] 候选列表就绪回调
     * @param {(candidate:object,result:object|null)=>void} [callbacks.onResult] 单个候选完成回调
     * @param {AbortSignal} [signal] 取消信号
     * @returns {Promise<object[]>} 匹配结果
     */
    async find(record, callbacks = {}, signal) {
        const { onProgress = () => {}, onCandidates = () => {}, onResult = () => {} } = callbacks;
        const now = Date.now();
        for (const [key, value] of this.resultCache) {
            if (value.expiresAt <= now) this.resultCache.delete(key);
        }
        const resultKey = [
            chatKey(record),
            record.messageCount ?? '',
            record.fileSize ?? '',
            record.lastMessageAt ?? '',
        ].join(':');
        const cached = this.resultCache.get(resultKey);
        if (cached?.expiresAt > Date.now()) {
            onCandidates(cached.matches);
            onProgress(cached.matches.length, cached.matches.length);
            cached.matches.forEach(match => onResult(match, match));
            return cached.matches;
        }

        const rawOwner = record.ownerType === 'character'
            ? record.ownerId.replace(/\.png$/i, '')
            : record.fileId;
        const [sanitized, allBackups] = await Promise.all([
            this.api.sanitizeFileName(rawOwner),
            this.list(signal),
        ]);
        const slug = sanitized.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const prefix = `chat_${slug}_`;
        const timestampPattern = /^\d{8}-\d{6}\.jsonl$/;
        const candidates = allBackups.filter(item => {
            const name = String(item.file_name);
            return name.startsWith(prefix)
                && timestampPattern.test(name.slice(prefix.length));
        }).sort((a, b) => new Date(b.last_mes).valueOf() - new Date(a.last_mes).valueOf());
        onCandidates(candidates);
        onProgress(0, candidates.length);
        if (!candidates.length) return [];

        const source = await loadStableSource(record, this.api, signal);
        const sourceIntegrity = source.header.chat_metadata?.integrity ?? null;
        let sourceHashesPromise;
        const getSourceHashes = () => sourceHashesPromise ??= Promise.all(
            source.messages.map(async message => toHex(await digestMessage(message))),
        );
        const matches = await this.#mapCandidates(candidates, async (candidate) => {
            try {
                const count = Number(candidate.chat_items);
                if (Number.isFinite(count) && count > source.messages.length) return null;
                if (sourceIntegrity) {
                    const candidateIntegrity = await this.#readIntegrity(candidate, signal);
                    if (candidateIntegrity === sourceIntegrity) {
                        return { ...candidate, status: 'matched', reason: '同一聊天的完整性标识' };
                    }
                    if (candidateIntegrity) return null;
                }
                return await this.#compareMessages(candidate, await getSourceHashes(), signal);
            } catch (error) {
                if (signal?.aborted) throw error;
                return { ...candidate, status: 'error', reason: error.message };
            }
        }, onProgress, onResult);
        const sorted = matches.sort((a, b) => new Date(b.last_mes).valueOf() - new Date(a.last_mes).valueOf());
        this.resultCache.set(resultKey, {
            expiresAt: Date.now() + MATCH_RESULT_CACHE_MS,
            matches: sorted,
        });
        return sorted;
    }

    /**
     * 读取带短时缓存的安全备份目录
     * @param {AbortSignal} [signal] 取消信号
     * @returns {Promise<object[]>} 备份列表
     */
    async list(signal) {
        if (this.backupListCache?.expiresAt > Date.now()) return this.backupListCache.items;
        if (!this.backupListPromise) {
            const revision = this.catalogRevision;
            const task = this.#createCatalog(signal).then(async ({ token, items }) => {
                if (revision !== this.catalogRevision) {
                    await this.api.finalizeDataMaidReport(token);
                    throw new Error('备份目录读取已取消');
                }
                const previousToken = this.reportToken;
                this.reportToken = token;
                this.reportLeases.set(token, {
                    readers: 0,
                    retired: false,
                    finalizing: null,
                });
                this.backupListCache = { expiresAt: Date.now() + BACKUP_LIST_CACHE_MS, items };
                if (previousToken && previousToken !== token) {
                    void this.#retireToken(previousToken).catch(error => {
                        console.warn('[酒馆工具箱] 释放旧备份目录失败', error);
                    });
                }
                return items;
            }).finally(() => {
                if (this.backupListPromise === task) this.backupListPromise = null;
            });
            this.backupListPromise = task;
        }
        return this.backupListPromise;
    }

    /**
     * 使用数据清理报告建立安全的备份目录，避开酒馆备份列表接口中的文件轮换竞态
     * @param {AbortSignal} [signal] 取消信号
     * @returns {Promise<{token:string,items:object[]}>} 报告令牌与备份条目
     */
    async #createCatalog(signal) {
        const result = await this.api.createDataMaidReport(signal);
        if (!result?.token || !Array.isArray(result.report?.chatBackups)) {
            if (result?.token) await this.api.finalizeDataMaidReport(result.token);
            throw new Error('安全备份目录格式无效');
        }
        const items = result.report.chatBackups.map(item => ({
            file_id: stripJsonl(item.name),
            file_name: String(item.name ?? ''),
            file_size: formatBytes(Number(item.size ?? 0)),
            file_bytes: Number(item.size ?? 0),
            chat_items: null,
            last_mes: Number(item.mtime ?? 0),
            hash: String(item.hash ?? ''),
        }));
        return { token: result.token, items };
    }

    /**
     * 在报告令牌有效期间读取并消费备份响应
     * @param {object|string} backup 备份条目或文件名
     * @param {(response:Response)=>Promise<*>} consume 响应消费器
     * @param {AbortSignal} [signal] 取消信号
     * @returns {Promise<*>} 消费结果
     */
    async #consume(backup, consume, signal) {
        let item = typeof backup === 'string'
            ? this.backupListCache?.items.find(candidate => candidate.file_name === backup)
            : backup;
        if (!item?.hash || !this.reportToken) {
            const items = await this.list(signal);
            const name = typeof backup === 'string' ? backup : backup?.file_name;
            item = items.find(candidate => candidate.file_name === name);
        }
        if (!item?.hash || !this.reportToken) throw new Error('备份已不存在，请重新读取备份列表');
        const token = this.reportToken;
        const lease = this.reportLeases.get(token);
        if (!lease) throw new Error('备份目录已失效，请重新读取备份列表');
        lease.readers++;
        try {
            const response = await this.api.readDataMaidFile(token, item.hash, signal);
            return await consume(response);
        } finally {
            await this.#releaseToken(token);
        }
    }

    /**
     * 仅读取备份头部的完整性标识
     * @param {object|string} backup 备份条目或文件名
     * @param {AbortSignal} [signal] 取消信号
     * @returns {Promise<string|null>} 完整性标识
     */
    async #readIntegrity(backup, signal) {
        let integrity = null;
        await this.#consume(backup, response => parseJsonlResponse(response, {
            stopAfter: 0,
            onHeader: (header) => {
                integrity = header.chat_metadata?.integrity ?? null;
            },
        }), signal);
        return integrity;
    }

    /**
     * 对缺少完整性标识的旧备份执行消息序列比对
     * @param {object} candidate 候选备份
     * @param {string[]} sourceHashes 原聊天消息摘要
     * @param {AbortSignal} [signal] 取消信号
     * @returns {Promise<object|null>} 匹配结果
     */
    async #compareMessages(candidate, sourceHashes, signal) {
        let sequenceMatches = true;
        let count = 0;
        await this.#consume(candidate, response => parseJsonlResponse(response, {
            onMessage: async (message, index) => {
                count = index + 1;
                if (index >= sourceHashes.length || toHex(await digestMessage(message)) !== sourceHashes[index]) {
                    sequenceMatches = false;
                }
            },
        }), signal);
        candidate.chat_items = count;
        if (sequenceMatches && count === sourceHashes.length) {
            return { ...candidate, status: 'matched', reason: '消息完整匹配' };
        }
        if (sequenceMatches && count <= sourceHashes.length) {
            return { ...candidate, status: 'confirm', reason: '消息前缀相关但缺少完整性标识' };
        }
        return null;
    }

    /**
     * 使用有限并发处理候选，避免串行等待或同时发起过多下载
     * @param {object[]} candidates 候选备份
     * @param {(candidate:object)=>Promise<object|null>} worker 匹配任务
     * @param {(done:number,total:number)=>void} onProgress 进度回调
     * @param {(candidate:object,result:object|null)=>void} onResult 单个候选完成回调
     * @returns {Promise<object[]>} 有效结果
     */
    async #mapCandidates(candidates, worker, onProgress, onResult) {
        const results = new Array(candidates.length);
        let cursor = 0;
        let done = 0;
        const run = async () => {
            while (cursor < candidates.length) {
                const index = cursor++;
                results[index] = await worker(candidates[index]);
                onResult(candidates[index], results[index]);
                done++;
                onProgress(done, candidates.length);
            }
        };
        const workers = Array.from({ length: Math.min(MATCH_CONCURRENCY, candidates.length) }, () => run());
        await Promise.all(workers);
        return results.filter(Boolean);
    }

    /**
     * 读取一页备份消息，不在内存中保留完整备份
     * @param {object|string} backup 备份条目或文件名
     * @param {number} page 从零开始的页码
     * @param {number} pageSize 每页数量
     * @param {AbortSignal} [signal] 取消信号
     * @returns {Promise<object[]>} 消息列表
     */
    async readPage(backup, page, pageSize = 50, signal) {
        const start = page * pageSize;
        const end = start + pageSize;
        const messages = [];
        await this.#consume(backup, response => parseJsonlResponse(response, {
            stopAfter: end,
            onMessage: (message, index) => {
                if (index >= start && index < end) messages.push(message);
            },
        }), signal);
        return messages;
    }

    /**
     * 下载备份文件
     * @param {object|string} backup 备份条目或文件名
     */
    async download(backup) {
        const blob = await this.readBlob(backup);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        const name = typeof backup === 'string' ? backup : backup.file_name;
        anchor.download = stripJsonl(name) + '.jsonl';
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /**
     * 读取备份为 Blob，供下载和酒馆原生导入链路复用
     * @param {object|string} backup 备份条目或文件名
     * @param {AbortSignal} [signal] 取消信号
     * @returns {Promise<Blob>} 备份文件内容
     */
    async readBlob(backup, signal) {
        return this.#consume(backup, response => response.blob(), signal);
    }

    /**
     * 释放一次报告读取租用，并在旧报告无人使用时完成清理
     * @param {string} token 报告令牌
     */
    async #releaseToken(token) {
        const lease = this.reportLeases.get(token);
        if (!lease) return;
        lease.readers = Math.max(0, lease.readers - 1);
        if (!lease.readers && lease.retired) {
            try {
                await this.#finalizeToken(token);
            } catch (error) {
                console.warn('[酒馆工具箱] 释放备份目录失败', error);
            }
        }
    }

    /**
     * 将报告标记为待释放
     * @param {string} token 报告令牌
     */
    async #retireToken(token) {
        const lease = this.reportLeases.get(token);
        if (!lease) return;
        lease.retired = true;
        if (!lease.readers) await this.#finalizeToken(token);
    }

    /**
     * 保证同一报告令牌只释放一次
     * @param {string} token 报告令牌
     */
    async #finalizeToken(token) {
        const lease = this.reportLeases.get(token);
        if (!lease) return;
        if (!lease.finalizing) {
            lease.finalizing = this.api.finalizeDataMaidReport(token).then(() => {
                if (this.reportLeases.get(token) === lease) this.reportLeases.delete(token);
            }).catch(error => {
                lease.finalizing = null;
                throw error;
            });
        }
        await lease.finalizing;
    }

    /**
     * 移除已删除备份的缓存
     * @param {Iterable<string>} names 已删除的备份文件名
     */
    forget(names) {
        const removed = new Set(names);
        if (this.backupListCache) {
            this.backupListCache.items = this.backupListCache.items.filter(item => !removed.has(item.file_name));
        }
        this.resultCache.clear();
    }

    /**
     * 释放安全备份目录的临时令牌
     */
    async dispose() {
        // 使仍在读取的旧目录只能释放自身令牌，不能重新写回缓存
        this.catalogRevision++;
        this.backupListPromise = null;
        const tokens = Array.from(this.reportLeases.keys());
        this.reportToken = '';
        this.backupListCache = null;
        this.resultCache.clear();
        await Promise.allSettled(tokens.map(token => this.#retireToken(token)));
    }
}
