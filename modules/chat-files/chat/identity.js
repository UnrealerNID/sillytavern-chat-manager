/**
 * 生成聊天记录的稳定所有者键
 * @param {object} record 聊天记录
 * @returns {string} 稳定键
 */
export function chatKey(record) {
    return `${record.ownerType}:${record.ownerId}:${record.fileId}`;
}

/**
 * 按聊天标识去重
 * @param {object[]} records 聊天记录
 * @returns {object[]} 去重后的聊天记录
 */
export function uniqueChatRecords(records) {
    return Array.from(new Map(records.map(record => [chatKey(record), record])).values());
}
