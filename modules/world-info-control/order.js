/**
 * 按酒馆原生世界书扫描顺序比较
 * @param {object} left 左侧条目
 * @param {object} right 右侧条目
 * @returns {number} 排序结果
 */
export function compareWorldInfoNativeOrder(left, right) {
    const nativeDifference = Number(left.nativeOrder ?? Number.MAX_SAFE_INTEGER)
        - Number(right.nativeOrder ?? Number.MAX_SAFE_INTEGER);
    if (nativeDifference) return nativeDifference;
    return Number(right.order ?? 0) - Number(left.order ?? 0);
}

/**
 * 先按酒馆原生扫描顺序排列，再建立世界书分组
 * @param {object[]} entries 激活条目
 * @returns {object[]} 世界书分组
 */
export function groupWorldInfoByNativeOrder(entries) {
    const groups = new Map();
    for (const entry of entries.slice().sort(compareWorldInfoNativeOrder)) {
        const name = entry.world || '未命名世界书';
        const values = groups.get(name) ?? [];
        values.push(entry);
        groups.set(name, values);
    }
    return Array.from(groups, ([name, values]) => ({ name, entries: values }));
}
