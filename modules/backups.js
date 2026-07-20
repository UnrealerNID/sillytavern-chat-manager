import { chatKey, digestMessage, parseJsonlResponse, stripJsonl, toHex } from './utils.js';
import { loadStableSource } from './source.js';

const BACKUP_LIST_CACHE_MS = 30_000;
const MATCH_RESULT_CACHE_MS = 60_000;
const MATCH_CONCURRENCY = 4;

export class BackupService {
    /** @param {import('./api.js').ChatManagerApi} api 接口实例 */
    constructor(api) {
        this.api = api;
        this.backupListCache = null;
        this.backupListPromise = null;
        this.resultCache = new Map();
    }

    /**
     * 查找与指定聊天相关的备份
     * @param {import('./utils.js').ChatRecord} record 聊天记录
     * @param {object} callbacks 扫描阶段回调
     * @param {(done:number,total:number)=>void} [callbacks.onProgress] 进度回调
     * @param {(candidates:object[])=>void} [callbacks.onCandidates] 候选列表就绪回调
     * @param {(candidate:object,result:object|null)=>void} [callbacks.onResult] 单个候选完成回调
     * @param {AbortSignal} [signal] 取消信号
     * @returns {Promise<object[]>} 匹配结果
     */
    async find(record, callbacks = {}, signal) {
        const { onProgress = () => {}, onCandidates = () => {}, onResult = () => {} } = callbacks;
        const resultKey = `${chatKey(record)}:${record.messageCount ?? ''}`;
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
            this.#listBackups(signal),
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
                    const candidateIntegrity = await this.#readIntegrity(candidate.file_name, signal);
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
     * 读取带短时缓存的原生备份列表
     * @param {AbortSignal} [signal] 取消信号
     * @returns {Promise<object[]>} 备份列表
     */
    async #listBackups(signal) {
        if (this.backupListCache?.expiresAt > Date.now()) return this.backupListCache.items;
        if (!this.backupListPromise) {
            this.backupListPromise = this.api.listBackups(signal).then((items) => {
                if (!Array.isArray(items)) throw new Error('备份列表格式无效');
                this.backupListCache = { expiresAt: Date.now() + BACKUP_LIST_CACHE_MS, items };
                return items;
            }).finally(() => {
                this.backupListPromise = null;
            });
        }
        return this.backupListPromise;
    }

    /**
     * 仅读取备份头部的完整性标识
     * @param {string} name 备份文件名
     * @param {AbortSignal} [signal] 取消信号
     * @returns {Promise<string|null>} 完整性标识
     */
    async #readIntegrity(name, signal) {
        let integrity = null;
        const response = await this.api.downloadBackup(name, signal);
        await parseJsonlResponse(response, {
            stopAfter: 0,
            onHeader: (header) => { integrity = header.chat_metadata?.integrity ?? null; },
        });
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
        const response = await this.api.downloadBackup(candidate.file_name, signal);
        await parseJsonlResponse(response, {
            onMessage: async (message, index) => {
                count = index + 1;
                if (index >= sourceHashes.length || toHex(await digestMessage(message)) !== sourceHashes[index]) {
                    sequenceMatches = false;
                }
            },
        });
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
     * @param {string} name 备份文件名
     * @param {number} page 从零开始的页码
     * @param {number} pageSize 每页数量
     * @param {AbortSignal} [signal] 取消信号
     * @returns {Promise<object[]>} 消息列表
     */
    async readPage(name, page, pageSize = 50, signal) {
        const start = page * pageSize;
        const end = start + pageSize;
        const messages = [];
        const response = await this.api.downloadBackup(name, signal);
        await parseJsonlResponse(response, {
            stopAfter: end,
            onMessage: (message, index) => {
                if (index >= start && index < end) messages.push(message);
            },
        });
        return messages;
    }

    /** @param {string} name 备份文件名 */
    async download(name) {
        const response = await this.api.downloadBackup(name);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = stripJsonl(name) + '.jsonl';
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}
