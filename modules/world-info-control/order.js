/**
 * 按酒馆最终组装提示词的方向比较
 * @param {object} left 左侧条目
 * @param {object} right 右侧条目
 * @returns {number} 排序结果
 */
export function compareWorldInfoNativeOrder(left, right) {
    const leftNativeOrder = Number.isFinite(left.nativeOrder) ? left.nativeOrder : -1;
    const rightNativeOrder = Number.isFinite(right.nativeOrder) ? right.nativeOrder : -1;
    // 酒馆按扫描顺序遍历条目，再用 unshift 组装提示词，因此展示方向需要反转
    const nativeDifference = rightNativeOrder - leftNativeOrder;
    if (nativeDifference) return nativeDifference;
    return Number(left.order ?? 0) - Number(right.order ?? 0);
}

/**
 * 先按酒馆最终组装方向排列，再建立世界书分组
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
