// 与酒馆 world_info_position 保持一致，避免在可独立测试的排序模块中引入浏览器入口
const AT_DEPTH_POSITION = 4;
const OUTLET_POSITION = 7;

/**
 * 按插入位置和该位置的正文组装方向比较条目
 * @param {object} left 左侧条目
 * @param {object} right 右侧条目
 * @returns {number} 排序结果
 */
export function compareWorldInfoEntryOrder(left, right) {
    const positionDifference = Number(left.position ?? 0) - Number(right.position ?? 0);
    if (positionDifference) return positionDifference;

    if (Number(left.position) === AT_DEPTH_POSITION) {
        // 深度越大越早进入聊天上下文
        const depthDifference = Number(right.depth ?? 0) - Number(left.depth ?? 0);
        if (depthDifference) return depthDifference;
    }

    // outlet 使用 push，其余位置使用 unshift，最终正文方向相反
    if (Number(left.position) === OUTLET_POSITION) {
        return Number(right.order ?? 0) - Number(left.order ?? 0);
    }
    return Number(left.order ?? 0) - Number(right.order ?? 0);
}

/**
 * 按来源和酒馆加载顺序建立分区，并独立排列书内条目
 * @param {object[]} entries 激活条目
 * @returns {object[]} 世界书来源分区
 */
export function groupWorldInfoSections(entries) {
    const groups = new Map();
    for (const entry of entries.slice().sort(compareWorldInfoEntryOrder)) {
        const name = entry.world || '未命名世界书';
        const sourceType = entry.sourceType ?? 'unknown';
        const key = `${sourceType}:${name}`;
        const group = groups.get(key) ?? {
            name,
            sourceType,
            sourceOrder: entry.sourceOrder ?? Number.MAX_SAFE_INTEGER,
            entries: [],
        };
        group.entries.push(entry);
        groups.set(key, group);
    }
    const sections = new Map();
    const sortedGroups = Array.from(groups.values()).sort((left, right) => (
        sourcePriority(left.sourceType) - sourcePriority(right.sourceType)
        || left.sourceOrder - right.sourceOrder
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
