/**
 * 构建包含首尾楼层的分卷范围
 * @param {number} start 起始楼层
 * @param {number} end 结束楼层
 * @param {number|null} chunkSize 可选的固定楼层数
 * @returns {object[]} 分卷范围，每项包含 start、end 和 count
 */
export function buildRanges(start, end, chunkSize = null) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
        throw new Error('楼层范围无效');
    }
    if (chunkSize === null) return [{ start, end, count: end - start + 1 }];
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('每卷楼层数必须大于 0');
    const ranges = [];
    for (let cursor = start; cursor <= end; cursor += chunkSize) {
        const rangeEnd = Math.min(end, cursor + chunkSize - 1);
        ranges.push({ start: cursor, end: rangeEnd, count: rangeEnd - cursor + 1 });
    }
    return ranges;
}
