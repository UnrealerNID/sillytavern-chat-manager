/**
 * 读取插件明确写入的分卷身份，不根据文件名猜测
 * @param {object} record 聊天记录
 * @returns {{rootChatId:string,sequence:number,start:number,end:number,count:number}|null}
 */
export function getStoredSplitIdentity(record) {
    const metadata = record.chatManager;
    const rootChatId = String(metadata?.rootChatId ?? '').trim();
    const sequence = Number(metadata?.sequence);
    const start = Number(metadata?.sourceStart);
    const end = Number(metadata?.sourceEnd);
    if (metadata?.schema !== 1 || !rootChatId || !Number.isInteger(sequence) || sequence < 1
        || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return null;
    return { rootChatId, sequence, start, end, count: end - start + 1 };
}

/**
 * 把同一所有者下同一分卷根名称的记录合并为显示单元
 * @param {object[]} records 已按时间排序的聊天记录
 * @param {object[]} [allRecords=records] 用于查找可能被筛选隐藏的源聊天
 * @returns {object[]}
 */
export function groupSplitRecords(records, allRecords = records) {
    const units = [];
    const seriesByKey = new Map();
    for (const record of records) {
        const split = getStoredSplitIdentity(record);
        if (!split) {
            const unit = { type: 'record', key: `record:${record.ownerType}:${record.ownerId}:${record.fileId}`, record };
            units.push(unit);
            continue;
        }
        const key = `split:${record.ownerType}:${record.ownerId}:${split.rootChatId}`;
        let series = seriesByKey.get(key);
        if (!series) {
            series = { type: 'split-group', key, ownerType: record.ownerType, ownerId: record.ownerId, ownerName: record.ownerName, rootChatId: split.rootChatId, records: [] };
            seriesByKey.set(key, series);
            units.push(series);
        }
        series.records.push({ record, split });
    }
    for (const series of seriesByKey.values()) {
        series.records.sort((a, b) => a.split.start - b.split.start || (a.split.sequence ?? 0) - (b.split.sequence ?? 0));
        series.sourceRecord = allRecords.find(record => record.ownerType === series.ownerType
            && String(record.ownerId) === String(series.ownerId)
            && record.fileId === series.rootChatId);
    }
    const sources = new Set(Array.from(seriesByKey.values(), series => series.sourceRecord).filter(Boolean));
    return units.filter(unit => unit.type !== 'record' || !sources.has(unit.record));
}

/**
 * 按稳定所有者 ID 合并聊天，并可继续在组内合并分卷
 * @param {object[]} records 已按时间排序的聊天记录
 * @param {boolean} groupSplits 是否合并分卷
 * @param {object[]} [allRecords=records] 全部聊天记录
 * @returns {object[]}
 */
export function groupOwnerRecords(records, groupSplits, allRecords = records) {
    const owners = [];
    const ownerByKey = new Map();
    for (const record of records) {
        const key = `owner:${record.ownerType}:${record.ownerId}`;
        let owner = ownerByKey.get(key);
        if (!owner) {
            owner = { type: 'owner-group', key, ownerType: record.ownerType, ownerId: record.ownerId, ownerName: record.ownerName, avatarUrl: record.avatarUrl, records: [] };
            ownerByKey.set(key, owner);
            owners.push(owner);
        }
        owner.records.push(record);
    }
    for (const owner of owners) {
        const allOwnerRecords = allRecords.filter(record => record.ownerType === owner.ownerType && String(record.ownerId) === String(owner.ownerId));
        owner.children = groupSplits
            ? groupSplitRecords(owner.records, allOwnerRecords)
            : owner.records.map(record => ({ type: 'record', key: `record:${record.ownerType}:${record.ownerId}:${record.fileId}`, record }));
    }
    return owners;
}

/**
 * 读取组内分卷记录明确保存的配置
 * @param {object} series 分卷显示单元
 * @returns {Array<{mode:'fixed',chunkSize:number,occurrences:number}>}
 */
export function getStoredSplitConfigs(series) {
    const occurrences = new Map();
    for (const part of series.records) {
        const metadata = part.record.chatManager;
        if (metadata?.splitMode !== 'fixed' || !Number.isInteger(metadata.chunkSize) || metadata.chunkSize < 1) continue;
        occurrences.set(metadata.chunkSize, (occurrences.get(metadata.chunkSize) ?? 0) + 1);
    }
    return Array.from(occurrences, ([chunkSize, count]) => ({ mode: 'fixed', chunkSize, occurrences: count }))
        .sort((a, b) => b.occurrences - a.occurrences || b.chunkSize - a.chunkSize);
}

/**
 * 根据最后一卷保存的元数据生成下一次增量分卷配置
 * @param {object} series 分卷显示单元
 * @returns {{available:boolean,reason:string,sourceRecord?:object,options?:object}}
 */
export function deriveIncrementalSplit(series) {
    const parts = [...series.records].sort((a, b) => a.split.start - b.split.start);
    if (!parts.length) return { available: false, reason: '没有可识别的分卷范围' };
    for (let index = 1; index < parts.length; index++) {
        if (parts[index].split.start !== parts[index - 1].split.end + 1) {
            return { available: false, reason: '已有分卷楼层范围不连续' };
        }
    }
    const lastPart = parts.at(-1);
    const sourceRecord = lastPart.record;
    const metadata = sourceRecord.chatManager;
    if (!metadata || metadata.rootChatId !== series.rootChatId || !['fixed', 'range'].includes(metadata.splitMode)
        || (metadata.splitMode === 'fixed' && (!Number.isInteger(metadata.chunkSize) || metadata.chunkSize < 1))) {
        return { available: false, reason: '最后一卷没有分卷配置' };
    }
    const sourceStart = Number(metadata.sourceStart);
    const sourceEnd = Number(metadata.sourceEnd);
    const originalCount = sourceEnd - sourceStart + 1;
    if (!Number.isInteger(originalCount) || originalCount < 1) {
        return { available: false, reason: '最后一卷的楼层配置无效' };
    }
    const currentCount = Number(sourceRecord.messageCount);
    if (currentCount <= originalCount) return { available: false, reason: '最后一卷没有新增楼层' };
    const lastEnd = lastPart.split.end;
    const sequenceStart = Math.max(...parts.map((part, index) => part.split.sequence ?? index + 1)) + 1;
    const mode = metadata.splitMode;
    const chunkSize = mode === 'fixed' ? metadata.chunkSize : currentCount - originalCount;
    const configs = getStoredSplitConfigs(series);
    return {
        available: true,
        reason: mode === 'fixed' ? `从 #${lastEnd + 1} 继续，每卷 ${chunkSize} 层` : `从 #${lastEnd + 1} 继续`,
        sourceRecord,
        options: {
            mode,
            start: originalCount,
            end: currentCount - 1,
            chunkSize,
            sequenceStart,
            incremental: true,
            outputRootChatId: series.rootChatId,
            rangeOffset: lastPart.split.start,
            groupConfigs: configs,
        },
    };
}
