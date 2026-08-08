/**
 * 按最终发送顺序合并连续且角色相同的消息
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
