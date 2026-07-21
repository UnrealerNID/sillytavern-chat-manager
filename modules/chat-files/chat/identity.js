/**
 * 生成聊天记录的稳定所有者键
 * @param {object} record 聊天记录
 * @returns {string} 稳定键
 */
export function chatKey(record) {
    return `${record.ownerType}:${record.ownerId}:${record.fileId}`;
}
