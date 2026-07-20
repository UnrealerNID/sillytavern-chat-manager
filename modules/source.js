import { cloneJson, stripJsonl } from './utils.js';

/** @param {unknown} value Value */
function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates a current or legacy chat header
 * @param {unknown} header Header
 * @returns {boolean} Whether valid
 */
export function isChatHeader(header) {
    return isObject(header) && (
        isObject(header.chat_metadata)
        || Object.hasOwn(header, 'user_name')
        || Object.hasOwn(header, 'character_name')
    );
}

/**
 * Reads one source fingerprint
 * @param {import('./utils.js').ChatRecord} record Chat record
 * @param {import('./api.js').ChatManagerApi} api API
 * @param {AbortSignal} [signal] Abort signal
 * @returns {Promise<object>} Fingerprint
 */
export async function getSourceFingerprint(record, api, signal) {
    if (record.ownerType === 'character') {
        const chats = await api.getCharacterChats(record.ownerId, { metadata: true, signal });
        if (!Array.isArray(chats)) throw new Error('角色聊天列表无效');
        const info = chats.find(item => stripJsonl(item.file_name) === record.fileId);
        if (!info) throw new Error('原聊天已不存在');
        return {
            ownerId: record.ownerId,
            fileId: record.fileId,
            fileSize: String(info.file_size ?? ''),
            messageCount: Number(info.chat_items),
            lastMessageAt: String(info.last_mes ?? ''),
            integrity: info.chat_metadata?.integrity ?? null,
        };
    }
    const info = await api.getGroupInfo(record.fileId, signal);
    return {
        ownerId: record.ownerId,
        fileId: record.fileId,
        fileSize: String(info?.file_size ?? ''),
        messageCount: Number(info?.chat_items),
        lastMessageAt: String(info?.last_mes ?? ''),
        integrity: null,
    };
}

/**
 * Compares source fingerprints
 * @param {object} left First fingerprint
 * @param {object} right Second fingerprint
 * @returns {boolean} Whether equal
 */
export function fingerprintsEqual(left, right) {
    const keys = ['ownerId', 'fileId', 'fileSize', 'messageCount', 'lastMessageAt'];
    if (!keys.every(key => left?.[key] === right?.[key])) return false;
    return !left?.integrity || !right?.integrity || left.integrity === right.integrity;
}

/**
 * Loads a stable, validated source chat snapshot
 * @param {import('./utils.js').ChatRecord} record Chat record
 * @param {import('./api.js').ChatManagerApi} api API
 * @param {AbortSignal} [signal] Abort signal
 * @returns {Promise<{header:object,messages:object[],fingerprint:object}>} Source snapshot
 */
export async function loadStableSource(record, api, signal) {
    const before = await getSourceFingerprint(record, api, signal);
    const data = record.ownerType === 'character'
        ? await api.getCharacterChat(record.ownerId, record.fileId, signal)
        : await api.getGroupChat(record.fileId, signal);
    const after = await getSourceFingerprint(record, api, signal);
    if (!fingerprintsEqual(before, after)) throw new Error('读取期间原聊天发生变化，请重试');
    if (!Array.isArray(data) || data.length < 1) throw new Error('原聊天为空或不存在');
    const [rawHeader, ...messages] = data;
    if (!isChatHeader(rawHeader)) throw new Error('原聊天头格式无效');
    if (!messages.every(isObject)) throw new Error('原聊天包含无效消息对象');
    if (messages.length !== after.messageCount) throw new Error('原聊天消息数与文件信息不一致，可能存在损坏行');
    const header = cloneJson(rawHeader);
    if (!isObject(header.chat_metadata)) header.chat_metadata = {};
    return { header, messages, fingerprint: after };
}
