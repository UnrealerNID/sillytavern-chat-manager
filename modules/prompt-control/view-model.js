import {
    groupContributionsBySource,
    groupWorldInfoContributions,
} from './snapshot.js';

/**
 * 按最终提示词顺序合并连续且角色相同的消息
 * @param {object[]} nodes 最终消息节点
 * @returns {object[]} 角色消息组
 */
export function groupAdjacentPromptNodes(nodes) {
    const groups = [];
    for (const node of nodes) {
        const current = groups.at(-1);
        if (!current || current.role !== node.role) {
            groups.push({
                id: node.id,
                role: node.role,
                nodes: [node],
                tokenCount: node.tokenCount,
            });
            continue;
        }
        current.nodes.push(node);
        current.tokenCount += node.tokenCount;
    }
    return groups;
}

/**
 * 按结构化提示词边界展开已被接口合并的最终消息
 * @param {object} snapshot 提示词快照
 * @returns {object[]} 用于提示词视图的消息节点
 */
export function createPromptDisplayNodes(snapshot) {
    const contributionsByNode = new Map();
    for (const item of snapshot.contributions ?? []) {
        if (!item.finalNodeId || item.controlLevel === 'source') continue;
        const items = contributionsByNode.get(item.finalNodeId) ?? [];
        items.push(item);
        contributionsByNode.set(item.finalNodeId, items);
    }
    return snapshot.finalNodes.flatMap(node => {
        const items = [...(contributionsByNode.get(node.id) ?? [])]
            .sort((left, right) => left.orderInNode - right.orderInNode);
        if (items.length <= 1) return [node];
        return items.map(item => ({
            id: `${node.id}:segment:${item.id}`,
            role: node.role,
            content: item.content,
            tokenCount: item.tokenCount,
            controlLevel: item.controlLevel,
            sourceName: item.sourceName,
        }));
    });
}

/**
 * 将来源分类转换为统一的“分组、子分组、来源项”树
 * @param {object[]} contributions 来源项
 * @returns {object[]} 来源树
 */
export function createSourceTree(contributions) {
    return groupContributionsBySource(contributions).map(group => {
        const children = group.id === 'worldInfo'
            ? groupWorldInfoContributions(group.items).map(world => ({
                id: `world:${world.id}`,
                label: world.label,
                allItems: world.items,
                items: world.items,
                children: [],
            }))
            : [];
        return {
            id: `source:${group.id}`,
            label: group.label,
            allItems: group.items,
            items: children.length ? [] : group.items,
            children,
        };
    });
}
