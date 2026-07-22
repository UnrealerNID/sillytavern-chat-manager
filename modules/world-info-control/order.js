/**
 * 按世界书条目进入最终提示词的顺序比较
 * @param {object} left 左侧条目
 * @param {object} right 右侧条目
 * @returns {number} 排序结果
 */
export function compareWorldInfoPromptOrder(left, right) {
    const positionDifference = Number(left.position ?? 0) - Number(right.position ?? 0);
    if (positionDifference) return positionDifference;

    // 深度越大越早进入聊天上下文，其余位置没有深度时自然保持不变
    const depthDifference = Number(right.depth ?? 0) - Number(left.depth ?? 0);
    if (depthDifference) return depthDifference;

    // 酒馆先按高顺序处理再用 unshift 组装，最终提示词中的正文顺序为升序
    return Number(left.order ?? 0) - Number(right.order ?? 0);
}

/**
 * 先按最终提示词顺序排列，再建立世界书分组
 * @param {object[]} entries 激活条目
 * @returns {object[]} 世界书分组
 */
export function groupWorldInfoByPromptOrder(entries) {
    const groups = new Map();
    for (const entry of entries.slice().sort(compareWorldInfoPromptOrder)) {
        const name = entry.world || '未命名世界书';
        const values = groups.get(name) ?? [];
        values.push(entry);
        groups.set(name, values);
    }
    return Array.from(groups, ([name, values]) => ({ name, entries: values }));
}
