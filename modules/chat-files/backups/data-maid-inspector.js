import { parseJsonlResponse } from '../../shared/utils.js';

const MATCH_CONCURRENCY = 4;

/**
 * 根据完整性标识判断备份对应状态
 * @param {string} integrity 备份完整性标识
 * @param {Set<string>} activeIntegrities 现有聊天标识
 * @returns {'linked'|'orphan'|'uncertain'} 对应状态
 */
export function classifyBackupIntegrity(integrity, activeIntegrities) {
    if (!integrity) return 'uncertain';
    return activeIntegrities.has(integrity) ? 'linked' : 'orphan';
}

/**
 * 判断备份状态是否符合筛选
 * @param {string} state 备份状态
 * @param {string} filter 筛选值
 * @returns {boolean} 是否显示
 */
export function backupStateMatchesFilter(state, filter) {
    if (filter === 'orphan') return state === 'orphan';
    if (filter === 'uncertain') return state === 'uncertain';
    if (filter === 'issues') return state === 'orphan' || state === 'uncertain';
    return true;
}

/**
 * 并发检查备份与现有聊天的完整性标识
 * @param {object} options 检查选项
 * @param {import('../api.js').ChatManagerApi} options.api 酒馆接口
 * @param {string} options.token 数据清理安全令牌
 * @param {object[]} options.items 备份增强条目
 * @param {AbortSignal} options.signal 取消信号
 * @param {(item:object)=>void} options.onState 单项状态回调
 * @param {(done:number,total:number)=>void} options.onProgress 进度回调
 * @returns {Promise<{orphan:number,uncertain:number}>} 检查统计
 */
export async function inspectDataMaidBackups({
    api,
    token,
    items,
    signal,
    onState,
    onProgress,
}) {
    const chats = await api.listChatFiles(signal);
    if (!Array.isArray(chats)) throw new Error('聊天文件接口返回格式无效');
    const activeIntegrities = new Set(chats
        .map(item => String(item.chat_metadata?.integrity ?? ''))
        .filter(Boolean));
    let cursor = 0;
    let done = 0;

    const run = async () => {
        while (cursor < items.length) {
            const item = items[cursor++];
            item.state = await inspectItem({
                api,
                token,
                item,
                signal,
                activeIntegrities,
            });
            onState(item);
            onProgress(++done, items.length);
        }
    };
    const workers = Math.min(MATCH_CONCURRENCY, items.length);
    await Promise.all(Array.from({ length: workers }, () => run()));
    return {
        orphan: items.filter(item => item.state === 'orphan').length,
        uncertain: items.filter(item => item.state === 'uncertain').length,
    };
}

/**
 * 检查单个备份
 * @param {object} options 检查选项
 * @returns {Promise<'linked'|'orphan'|'uncertain'>} 对应状态
 */
async function inspectItem({ api, token, item, signal, activeIntegrities }) {
    let integrity = null;
    try {
        const response = await api.readDataMaidFile(token, item.record.hash, signal);
        await parseJsonlResponse(response, {
            stopAfter: 0,
            onHeader: header => {
                integrity = header.chat_metadata?.integrity ?? null;
            },
        });
        return classifyBackupIntegrity(integrity, activeIntegrities);
    } catch (error) {
        if (signal.aborted) throw error;
        return 'uncertain';
    }
}
