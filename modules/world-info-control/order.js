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

    // 酒馆先按高顺序处理再用 unshift 组装，同一位置中的最终正文顺序为升序
    return Number(left.order ?? 0) - Number(right.order ?? 0);
}

/**
 * 按来源和酒馆文件名顺序建立分区，并独立排列书内条目
 * @param {object[]} entries 激活条目
 * @returns {object[]} 世界书来源分区
 */
export function groupWorldInfoSections(entries) {
    const groups = new Map();
    for (const entry of entries.slice().sort(compareWorldInfoPromptOrder)) {
        const name = entry.world || '未命名世界书';
        const sourceType = entry.sourceType ?? 'unknown';
        const key = `${sourceType}:${name}`;
        const group = groups.get(key) ?? { name, sourceType, entries: [] };
        group.entries.push(entry);
        groups.set(key, group);
    }
    const sections = new Map();
    const sortedGroups = Array.from(groups.values()).sort((left, right) => (
        sourcePriority(left.sourceType) - sourcePriority(right.sourceType)
        || left.name.localeCompare(right.name)
    ));
    for (const group of sortedGroups) {
        const values = sections.get(group.sourceType) ?? [];
        values.push(group);
        sections.set(group.sourceType, values);
    }
    return Array.from(sections, ([sourceType, sectionGroups]) => ({
        sourceType,
        label: sourceLabel(sourceType),
        groups: sectionGroups,
    }));
}

function sourcePriority(sourceType) {
    const index = ['character', 'global', 'chat', 'persona', 'unknown'].indexOf(sourceType);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function sourceLabel(sourceType) {
    return {
        character: '角色世界书',
        global: '全局世界书',
        chat: '聊天世界书',
        persona: '用户世界书',
        unknown: '其他世界书',
    }[sourceType] ?? '其他世界书';
}
