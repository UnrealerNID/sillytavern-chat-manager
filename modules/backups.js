import { digestMessage, parseJsonlResponse, stripJsonl, toHex } from './utils.js';
import { loadStableSource } from './source.js';

export class BackupService {
    /** @param {import('./api.js').ChatManagerApi} api API */
    constructor(api) {
        this.api = api;
    }

    /**
     * Finds backups related to one exact chat
     * @param {import('./utils.js').ChatRecord} record Chat record
     * @param {(done:number,total:number)=>void} onProgress Progress callback
     * @param {AbortSignal} [signal] Abort signal
     * @returns {Promise<object[]>} Matches
     */
    async find(record, onProgress = () => {}, signal) {
        const source = await loadStableSource(record, this.api, signal);
        const rawOwner = record.ownerType === 'character'
            ? record.ownerId.replace(/\.png$/i, '')
            : record.fileId;
        const sanitized = await this.api.sanitizeFileName(rawOwner);
        const slug = sanitized.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const prefix = `chat_${slug}_`;
        const allBackups = await this.api.listBackups(signal);
        if (!Array.isArray(allBackups)) throw new Error('备份列表格式无效');
        const timestampPattern = /^\d{8}-\d{6}\.jsonl$/;
        const candidates = allBackups.filter(item => {
            const name = String(item.file_name);
            return name.startsWith(prefix) && timestampPattern.test(name.slice(prefix.length));
        });
        const sourceHashes = [];
        for (const message of source.messages) sourceHashes.push(toHex(await digestMessage(message)));
        const sourceIntegrity = source.header.chat_metadata?.integrity ?? null;
        const matches = [];

        for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
            const candidate = candidates[candidateIndex];
            let headerIntegrity = null;
            let sequenceMatches = true;
            let count = 0;
            try {
                const response = await this.api.downloadBackup(candidate.file_name, signal);
                await parseJsonlResponse(response, {
                    onHeader: (header) => { headerIntegrity = header.chat_metadata?.integrity ?? null; },
                    onMessage: async (message, index) => {
                        count = index + 1;
                        if (index >= sourceHashes.length || toHex(await digestMessage(message)) !== sourceHashes[index]) {
                            sequenceMatches = false;
                        }
                    },
                });
            } catch (error) {
                if (signal?.aborted) throw error;
                matches.push({ ...candidate, status: 'error', reason: error.message });
                onProgress(candidateIndex + 1, candidates.length);
                continue;
            }

            const exact = sequenceMatches && count === sourceHashes.length;
            const prefixMatch = sequenceMatches && count <= sourceHashes.length;
            const integrityMatch = !!sourceIntegrity && sourceIntegrity === headerIntegrity;
            if (exact || (prefixMatch && integrityMatch)) {
                matches.push({ ...candidate, status: 'matched', reason: exact ? '消息完整匹配' : '同一聊天的历史前缀' });
            } else if (prefixMatch || integrityMatch) {
                matches.push({ ...candidate, status: 'confirm', reason: integrityMatch ? '完整性标识相同但消息不同' : '消息前缀相关但缺少完整性标识' });
            }
            onProgress(candidateIndex + 1, candidates.length);
        }
        return matches.sort((a, b) => new Date(b.last_mes).valueOf() - new Date(a.last_mes).valueOf());
    }

    /**
     * Reads one backup page without retaining the whole backup
     * @param {string} name Backup file name
     * @param {number} page Zero-based page
     * @param {number} pageSize Page size
     * @param {AbortSignal} [signal] Abort signal
     * @returns {Promise<object[]>} Messages
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

    /** @param {string} name Backup file name */
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
