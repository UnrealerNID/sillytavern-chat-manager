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
 * 按来源和酒馆文件名顺序建立分区，并在组内保留最终组装方向
 * @param {object[]} entries 激活条目
 * @returns {object[]} 世界书来源分区
 */
export function groupWorldInfoSections(entries) {
    const groups = new Map();
    for (const entry of entries.slice().sort(compareWorldInfoNativeOrder)) {
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
