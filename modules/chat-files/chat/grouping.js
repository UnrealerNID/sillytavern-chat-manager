import { parseBytes } from '../../shared/files.js';

/**
 * 按聊天管理面板的排序方式返回新数组
 * @param {object[]} records 聊天记录
 * @param {'newest'|'oldest'|'largest'|'messages'|'name'} order 排序方式
 * @returns {object[]} 排序后的聊天记录
 */
export function sortChatRecords(records, order = 'newest') {
    const time = record => {
        const value = new Date(record.lastMessageAt).valueOf();
        return Number.isFinite(value) ? value : 0;
    };
    const name = record => `${record.ownerName}\u0000${record.fileId}`;
    const newest = (left, right) => time(right) - time(left);
    const tie = (left, right) => newest(left, right)
        || name(left).localeCompare(name(right), 'zh-CN', { numeric: true });
    const compare = {
        newest,
        oldest: (left, right) => time(left) - time(right),
        largest: (left, right) => parseBytes(right.fileSize) - parseBytes(left.fileSize),
        messages: (left, right) => Number(right.messageCount || 0) - Number(left.messageCount || 0),
        name: (left, right) => name(left).localeCompare(name(right), 'zh-CN', { numeric: true }),
    }[order] ?? newest;
    return [...records].sort((left, right) => compare(left, right) || tie(left, right));
}

/**
 * 从酒馆上下文解析当前角色或群组
 * @param {object} context 酒馆上下文
 * @returns {object|null} 当前所有者类型、标识和显示名称
 */
export function getCurrentOwner(context) {
    if (context.groupId !== undefined && context.groupId !== null) {
        const group = context.groups.find(item => String(item.id) === String(context.groupId));
        return group ? { ownerType: 'group', ownerId: String(group.id), label: '当前群组' } : null;
    }
    const character = context.characterId !== undefined && context.characterId !== null
        ? context.characters[context.characterId]
        : null;
    return character?.avatar
        ? { ownerType: 'character', ownerId: String(character.avatar), label: '当前角色' }
        : null;
}

/**
 * 按显示范围和搜索词过滤聊天记录
 * @param {object[]} records 全部聊天记录
 * @param {'current'|'all'} scope 显示范围
 * @param {object|null} currentOwner 当前所有者
 * @param {string} query 搜索词
 * @returns {object[]} 过滤结果
 */
export function filterChatRecords(records, scope, currentOwner, query) {
    const normalized = query.trim().toLocaleLowerCase();
    return records.filter(record => {
        const inScope = scope === 'all' || currentOwner
            && record.ownerType === currentOwner.ownerType
            && String(record.ownerId) === String(currentOwner.ownerId);
        return inScope && (!normalized || [record.ownerName, record.fileId]
            .some(value => value.toLocaleLowerCase().includes(normalized)));
    });
}

/**
 * 读取插件明确写入的分卷身份，不根据文件名猜测
 * @param {object} record 聊天记录
 * @returns {object|null} 分卷组标识、序号和楼层范围
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
    const allSeriesByKey = new Map();
    const recordByOwnerFile = new Map();
    for (const record of allRecords) {
        recordByOwnerFile.set(ownerFileKey(record, record.fileId), record);
        const split = getStoredSplitIdentity(record);
        if (!split) continue;
        const key = splitSeriesKey(record, split.rootChatId);
        if (!allSeriesByKey.has(key)) allSeriesByKey.set(key, []);
        allSeriesByKey.get(key).push({ record, split });
    }
    for (const record of records) {
        const split = getStoredSplitIdentity(record);
        if (!split) {
            units.push(recordUnit(record));
            continue;
        }
        const key = splitSeriesKey(record, split.rootChatId);
        let series = seriesByKey.get(key);
        if (!series) {
            series = {
                type: 'split-group',
                key,
                ownerType: record.ownerType,
                ownerId: record.ownerId,
                ownerName: record.ownerName,
                rootChatId: split.rootChatId,
                records: [],
            };
            seriesByKey.set(key, series);
            units.push(series);
        }
        series.records.push({ record, split });
    }
    for (const series of seriesByKey.values()) {
        series.records.sort(compareSplitItems);
        series.allRecords = [...(allSeriesByKey.get(series.key) ?? [])].sort(compareSplitItems);
        series.sourceRecord = recordByOwnerFile.get(ownerFileKey(series, series.rootChatId));
    }
    const sources = new Set(Array.from(seriesByKey.values(), series => series.sourceRecord).filter(Boolean));
    return units.filter(unit => unit.type !== 'record' || !sources.has(unit.record));
}

/**
 * 生成统一的分卷展示顺序，新卷在前且源聊天固定在末尾
 * @param {object} group 分卷组
 * @returns {Array<{record:object,source:boolean}>} 展示记录
 */
export function orderSplitGroupRecords(group) {
    const ordered = [...group.records]
        .sort((left, right) => right.split.sequence - left.split.sequence)
        .map(item => ({ record: item.record, source: false }));
    if (group.sourceRecord) ordered.push({ record: group.sourceRecord, source: true });
    return ordered;
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
    const allRecordsByOwner = new Map();
    for (const record of allRecords) {
        const key = ownerKey(record);
        if (!allRecordsByOwner.has(key)) allRecordsByOwner.set(key, []);
        allRecordsByOwner.get(key).push(record);
    }
    for (const record of records) {
        const key = ownerKey(record);
        let owner = ownerByKey.get(key);
        if (!owner) {
            owner = {
                type: 'owner-group',
                key,
                ownerType: record.ownerType,
                ownerId: record.ownerId,
                ownerName: record.ownerName,
                avatarUrl: record.avatarUrl,
                records: [],
            };
            ownerByKey.set(key, owner);
            owners.push(owner);
        }
        owner.records.push(record);
    }
    for (const owner of owners) {
        const allOwnerRecords = allRecordsByOwner.get(owner.key) ?? [];
        owner.allRecords = allOwnerRecords;
        owner.splitGroupCount = groupSplits
            ? groupSplitRecords(allOwnerRecords, allOwnerRecords).filter(unit => unit.type === 'split-group').length
            : 0;
        owner.children = groupSplits
            ? groupSplitRecords(owner.records, allOwnerRecords)
            : owner.records.map(recordUnit);
    }
    return owners;
}

function ownerKey(record) {
    return `owner:${record.ownerType}:${record.ownerId}`;
}

function ownerFileKey(record, fileId) {
    return `${record.ownerType}:${record.ownerId}:${fileId}`;
}

function splitSeriesKey(record, rootChatId) {
    return `split:${ownerFileKey(record, rootChatId)}`;
}

/**
 * 创建聊天记录显示单元
 * @param {object} record 聊天记录
 * @returns {object} 显示单元
 */
function recordUnit(record) {
    return {
        type: 'record',
        key: `record:${record.ownerType}:${record.ownerId}:${record.fileId}`,
        record,
    };
}

/**
 * 按楼层和卷号排列分卷
 * @param {object} left 左侧分卷
 * @param {object} right 右侧分卷
 * @returns {number} 排序结果
 */
function compareSplitItems(left, right) {
    return left.split.start - right.split.start
        || (left.split.sequence ?? 0) - (right.split.sequence ?? 0);
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
        if (metadata?.splitMode !== 'fixed'
            || !Number.isInteger(metadata.chunkSize)
            || metadata.chunkSize < 1) continue;
        occurrences.set(metadata.chunkSize, (occurrences.get(metadata.chunkSize) ?? 0) + 1);
    }
    return Array.from(occurrences, ([chunkSize, count]) => ({ mode: 'fixed', chunkSize, occurrences: count }))
        .sort((a, b) => b.occurrences - a.occurrences || b.chunkSize - a.chunkSize);
}

/**
 * 汇总分卷组的逻辑范围与尾卷待处理消息
 *
 * 最后一卷可以继续聊天，其文件会同时包含已封存楼层和新增楼层
 * 新增楼层在生成下一卷前只计入逻辑范围，不能与旧卷文件长度重复累计
 * @param {object} series 分卷显示单元
 * @returns {object} 分卷顺序、连续性、逻辑范围及尾卷的逻辑与本地范围
 */
export function getSplitGroupState(series) {
    const parts = [...series.records].sort(compareSplitItems);
    if (!parts.length) {
        return {
            parts,
            continuous: false,
            start: 0,
            end: -1,
            messageCount: 0,
            pendingCount: 0,
            pendingStart: 0,
            pendingEnd: -1,
            pendingLocalStart: 0,
            pendingLocalEnd: -1,
        };
    }

    const continuous = parts.every((part, index) => (
        index === 0 || part.split.start === parts[index - 1].split.end + 1
    ));
    const lastPart = parts.at(-1);
    const storedCount = parts.reduce((sum, part) => sum + part.split.count, 0);
    const tailStoredCount = lastPart.split.count;
    const tailFileCount = Math.max(0, Number(lastPart.record.messageCount) || 0);
    const pendingCount = Math.max(0, tailFileCount - tailStoredCount);
    const tailStart = lastPart.split.start;

    return {
        parts,
        continuous,
        start: parts[0].split.start,
        end: tailStart + tailFileCount - 1,
        messageCount: storedCount + pendingCount,
        pendingCount,
        pendingStart: tailStart + tailStoredCount,
        pendingEnd: tailStart + tailFileCount - 1,
        pendingLocalStart: tailStoredCount,
        pendingLocalEnd: tailFileCount - 1,
    };
}

/**
 * 根据最后一卷保存的元数据生成下一次增量分卷配置
 * @param {object} series 分卷显示单元
 * @returns {object} 可用状态、原因、尾卷聊天和增量分卷参数
 */
export function deriveIncrementalSplit(series) {
    const state = getSplitGroupState(series);
    const { parts } = state;
    if (!parts.length) return { available: false, reason: '没有可识别的分卷范围' };
    if (!state.continuous) return { available: false, reason: '已有分卷楼层范围不连续' };
    const lastPart = parts.at(-1);
    const tailRecord = lastPart.record;
    const metadata = tailRecord.chatManager;
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
    const currentCount = Number(tailRecord.messageCount);
    if (!state.pendingCount) return { available: false, reason: '最后一卷没有新增楼层' };
    const sequenceStart = Math.max(...parts.map((part, index) => part.split.sequence ?? index + 1)) + 1;
    const mode = metadata.splitMode;
    const chunkSize = mode === 'fixed' ? metadata.chunkSize : currentCount - originalCount;
    const configs = getStoredSplitConfigs(series);
    return {
        available: true,
        reason: mode === 'fixed'
            ? `最后一卷新增 #${state.pendingLocalStart}–#${state.pendingLocalEnd}，每卷 ${chunkSize} 层`
            : `最后一卷新增 #${state.pendingLocalStart}–#${state.pendingLocalEnd}`,
        record: tailRecord,
        options: {
            mode,
            start: state.pendingLocalStart,
            end: state.pendingLocalEnd,
            chunkSize,
            sequenceStart,
            incremental: true,
            outputRootChatId: series.rootChatId,
            rangeOffset: lastPart.split.start,
            groupConfigs: configs,
        },
    };
}
