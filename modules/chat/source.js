import { cloneJson, stripJsonl } from '../shared/utils.js';

/**
 * 判断值是否为普通对象
 * @param {unknown} value 待判断的值
 * @returns {boolean} 是否为对象
 */
function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 校验当前或旧版聊天头
 * @param {unknown} header 聊天头
 * @returns {boolean} 是否有效
 */
export function isChatHeader(header) {
    return isObject(header) && (
        isObject(header.chat_metadata)
        || Object.hasOwn(header, 'user_name')
        || Object.hasOwn(header, 'character_name')
    );
}

/**
 * 读取一份来源聊天指纹
 * @param {object} record 聊天记录
 * @param {import('../platform/api.js').ChatManagerApi} api 接口实例
 * @param {AbortSignal} [signal] 取消信号
 * @returns {Promise<object>} 来源指纹
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
 * 比较两份来源指纹
 * @param {object} left 第一份指纹
 * @param {object} right 第二份指纹
 * @returns {boolean} 是否相同
 */
export function fingerprintsEqual(left, right) {
    const keys = ['ownerId', 'fileId', 'fileSize', 'messageCount', 'lastMessageAt'];
    if (!keys.every(key => left?.[key] === right?.[key])) return false;
    return !left?.integrity || !right?.integrity || left.integrity === right.integrity;
}

/**
 * 读取并校验稳定的来源聊天快照
 * @param {object} record 聊天记录
 * @param {import('../platform/api.js').ChatManagerApi} api 接口实例
 * @param {AbortSignal} [signal] 取消信号
 * @returns {Promise<{header:object,messages:object[],fingerprint:object}>} 来源快照
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
