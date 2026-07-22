const SOURCE_LABELS = Object.freeze({
    preset: '预设',
    worldInfo: '世界书',
    character: '角色与人设',
    example: '示例消息',
    chat: '上下文消息',
    extension: '扩展注入',
    control: '生成控制',
    other: '其他',
});

/**
 * 管理当前聊天的提示词快照与临时排除状态
 */
export class PromptSnapshotStore {
    constructor() {
        this.snapshot = null;
        this.status = 'idle';
        this.chatKey = '';
        this.exclusions = new Map();
        this.listeners = new Set();
    }

    /**
     * 切换当前聊天
     * @param {string} chatKey 聊天标识
     */
    setChatKey(chatKey) {
        if (this.chatKey === chatKey) return;
        this.chatKey = chatKey;
        this.snapshot = null;
        this.#notify();
    }

    /**
     * 保存最新快照
     * @param {object|null} snapshot 提示词快照
     */
    setSnapshot(snapshot) {
        this.snapshot = snapshot;
        this.#notify();
    }

    /**
     * 获取当前快照
     * @returns {object|null} 当前快照
     */
    getSnapshot() {
        return this.snapshot;
    }

    /**
     * 更新捕获状态
     * @param {'idle'|'stale'|'loading'|'ready'|'error'} status 捕获状态
     */
    setStatus(status) {
        if (this.status === status) return;
        this.status = status;
        this.#notify();
    }

    /**
     * 获取捕获状态
     * @returns {string} 捕获状态
     */
    getStatus() {
        return this.status;
    }

    /**
     * 获取当前聊天排除集合的副本
     * @returns {Set<string>} 排除标识集合
     */
    getExclusions() {
        return new Set(this.exclusions.get(this.chatKey) ?? []);
    }

    /**
     * 判断控制项是否排除
     * @param {string} controlId 控制项标识
     * @returns {boolean} 是否排除
     */
    isExcluded(controlId) {
        return this.exclusions.get(this.chatKey)?.has(controlId) ?? false;
    }

    /**
     * 切换控制项发送状态
     * @param {string} controlId 控制项标识
     * @param {boolean} excluded 是否排除
     */
    setExcluded(controlId, excluded) {
        if (!controlId || !this.chatKey) return;
        const values = this.exclusions.get(this.chatKey) ?? new Set();
        if (excluded) values.add(controlId);
        else values.delete(controlId);
        if (values.size) this.exclusions.set(this.chatKey, values);
        else this.exclusions.delete(this.chatKey);
        this.#notify();
    }

    /**
     * 清空当前聊天的临时排除
     */
    clearCurrent() {
        if (!this.exclusions.delete(this.chatKey)) return;
        this.#notify();
    }

    /**
     * 清空全部运行时状态
     */
    clearAll() {
        this.snapshot = null;
        this.status = 'idle';
        this.exclusions.clear();
        this.#notify();
    }

    /**
     * 订阅状态变化
     * @param {()=>void} listener 监听器
     * @returns {()=>void} 取消订阅函数
     */
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    #notify() {
        for (const listener of this.listeners) listener();
    }
}

/**
 * 创建当前聊天的稳定标识
 * @param {object} context 酒馆上下文
 * @returns {string} 聊天标识
 */
export function getPromptChatKey(context) {
    const owner = context.groupId
        ? `group:${context.groupId}`
        : `character:${context.characterId ?? 'none'}`;
    return `${owner}:${context.chatId ?? 'none'}`;
}

/**
 * 将聊天补全请求转换为统一快照
 * @param {object} options 配置项
 * @param {object[]} options.chat 最终消息数组
 * @param {object|null} options.messages 酒馆结构化消息集合
 * @param {(text:string)=>Promise<number>} options.countTokens Token 计算器
 * @param {boolean} options.dryRun 是否为预览
 * @param {object[]} [options.worldEntries] 本轮激活世界书条目
 * @returns {Promise<object>} 提示词快照
 */
export async function createChatSnapshot({
    chat,
    messages,
    countTokens,
    dryRun,
    worldEntries = [],
}) {
    const structured = flattenStructuredMessages(messages);
    const matches = matchFinalMessages(chat, structured);
    const finalNodes = await Promise.all(chat.map(async (message, index) => {
        const contributions = matches[index] ?? [];
        const content = promptContentToText(message.content);
        const identity = contributions.map(item => item.identifier).join('|') || `${message.role}:${index}`;
        return {
            id: `final:${stableHash(`${identity}@${index}`)}`,
            sendIndex: index,
            role: message.role ?? 'unknown',
            content,
            tokenCount: await countTokens(content),
            controlLevel: isProtocolMessage(message) ? 'locked' : 'final',
            contributionIds: contributions.map(item => item.identifier),
        };
    }));
    const finalByContribution = new Map();
    for (const node of finalNodes) {
        for (const identifier of node.contributionIds) finalByContribution.set(identifier, node);
    }
    const contributions = structured.map(item => {
        const finalNode = finalByContribution.get(item.identifier);
        return {
            id: item.identifier,
            controlId: finalNode?.id ?? '',
            sourceType: classifySource(item.identifier),
            sourceName: sourceName(item.identifier),
            finalNodeId: finalNode?.id ?? null,
            orderInNode: finalNode?.contributionIds.indexOf(item.identifier) ?? -1,
            content: item.content,
            tokenCount: item.tokenCount,
            controlLevel: finalNode?.contributionIds.length === 1 ? finalNode.controlLevel : 'locked',
        };
    });
    await appendWorldEntries(contributions, finalByContribution, worldEntries, countTokens);
    return {
        api: 'chat-completion',
        kind: dryRun ? 'preview' : 'actual',
        capturedAt: Date.now(),
        finalNodes,
        contributions,
        totalTokens: finalNodes.reduce((total, node) => total + node.tokenCount, 0),
    };
}

/**
 * 创建文本补全快照
 * @param {object} options 配置项
 * @param {string} options.prompt 最终提示词
 * @param {(text:string)=>Promise<number>} options.countTokens Token 计算器
 * @param {boolean} options.dryRun 是否为预览
 * @param {object[]} [options.parts] 合并前区段
 * @returns {Promise<object>} 提示词快照
 */
export async function createTextSnapshot({ prompt, countTokens, dryRun, parts = [] }) {
    const content = String(prompt ?? '');
    const finalNode = {
        id: `final:${stableHash(content)}`,
        sendIndex: 0,
        role: 'prompt',
        content,
        tokenCount: await countTokens(content),
        controlLevel: 'locked',
        contributionIds: parts.map(part => part.id),
    };
    const contributions = await Promise.all(parts.map(async (part, index) => ({
        id: part.id,
        controlId: '',
        sourceType: part.sourceType,
        sourceName: part.sourceName,
        finalNodeId: finalNode.id,
        orderInNode: index,
        content: part.content,
        tokenCount: await countTokens(part.content),
        controlLevel: 'locked',
    })));
    return {
        api: 'text-completion',
        kind: dryRun ? 'preview' : 'actual',
        capturedAt: Date.now(),
        finalNodes: [finalNode],
        contributions,
        totalTokens: finalNode.tokenCount,
    };
}

/**
 * 按来源类型生成视图分组
 * @param {object[]} contributions 来源项
 * @returns {object[]} 来源分组
 */
export function groupContributionsBySource(contributions) {
    const groups = new Map();
    for (const item of contributions) {
        const group = groups.get(item.sourceType) ?? {
            id: item.sourceType,
            label: SOURCE_LABELS[item.sourceType] ?? SOURCE_LABELS.other,
            items: [],
        };
        group.items.push(item);
        groups.set(item.sourceType, group);
    }
    return Array.from(groups.values());
}

/**
 * 将酒馆结构化消息展开为叶子消息
 * @param {object|null} root 根消息集合
 * @returns {object[]} 结构化消息
 */
export function flattenStructuredMessages(root) {
    const output = [];
    const visit = value => {
        const collection = value?.getCollection?.() ?? value?.collection;
        if (Array.isArray(collection)) {
            collection.forEach(visit);
            return;
        }
        if (!value || (!value.content && !value.tool_calls)) return;
        output.push({
            identifier: String(value.identifier ?? `message-${output.length}`),
            role: value.role ?? 'unknown',
            content: promptContentToText(value.content ?? value.tool_calls),
            tokenCount: Number(value.getTokens?.() ?? value.tokens ?? 0),
        });
    };
    visit(root);
    return output;
}

/**
 * 将多模态提示词内容转换为可查看文本
 * @param {unknown} content 提示词内容
 * @returns {string} 可查看文本
 */
export function promptContentToText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content ? JSON.stringify(content, null, 2) : '';
    return content.map(item => {
        if (item?.type === 'text') return item.text ?? '';
        if (item?.type === 'image_url') return '[图片]';
        if (item?.type === 'video_url') return '[视频]';
        if (item?.type === 'audio_url') return '[音频]';
        return JSON.stringify(item);
    }).join('\n');
}

function matchFinalMessages(chat, structured) {
    const matches = [];
    let cursor = 0;
    for (const message of chat) {
        const content = promptContentToText(message.content);
        const direct = structured[cursor];
        if (direct && direct.role === message.role && direct.content === content) {
            matches.push([direct]);
            cursor += 1;
            continue;
        }
        const merged = [];
        let combined = '';
        let probe = cursor;
        while (probe < structured.length && structured[probe].role === message.role) {
            const item = structured[probe];
            merged.push(item);
            combined = combined ? `${combined}\n${item.content}` : item.content;
            probe += 1;
            if (combined === content) break;
            if (!content.startsWith(combined)) break;
        }
        if (combined === content) {
            cursor = probe;
            matches.push(merged);
        } else {
            matches.push([]);
        }
    }
    return matches;
}

async function appendWorldEntries(contributions, finalByContribution, entries, countTokens) {
    for (const [index, entry] of entries.entries()) {
        const anchorId = worldAnchor(entry);
        const anchor = anchorId ? finalByContribution.get(anchorId) : null;
        const id = `world:${entry.world ?? 'unknown'}:${entry.uid}`;
        contributions.push({
            id,
            controlId: id,
            sourceType: 'worldInfo',
            sourceName: entry.comment || entry.key?.join?.(', ') || entry.world || '世界书条目',
            finalNodeId: anchor?.id ?? null,
            orderInNode: index,
            content: String(entry.content ?? ''),
            tokenCount: await countTokens(String(entry.content ?? '')),
            controlLevel: 'source',
        });
    }
}

function worldAnchor(entry) {
    if (Number(entry.position) === 0) return 'worldInfoBefore';
    if (Number(entry.position) === 1) return 'worldInfoAfter';
    return null;
}

function classifySource(identifier) {
    if (/^worldInfo/.test(identifier)) return 'worldInfo';
    if (/^(char|scenario|persona)/.test(identifier)) return 'character';
    if (/^(chatHistory|newMainChat)/.test(identifier)) return 'chat';
    if (/^(dialogueExamples|newChat)/.test(identifier)) return 'example';
    if (/^(authorsNote|summary|vectors|smartContext)/.test(identifier)) return 'extension';
    if (/^(controlPrompts|quietPrompt|continue|bias|impersonate|groupNudge)/.test(identifier)) {
        return 'control';
    }
    if (/^(main|nsfw|jailbreak|enhanceDefinitions)/.test(identifier)) return 'preset';
    return 'other';
}

function sourceName(identifier) {
    const names = {
        main: '主提示词',
        nsfw: '辅助提示词',
        jailbreak: '后置提示词',
        worldInfoBefore: '角色定义前世界书',
        worldInfoAfter: '角色定义后世界书',
        charDescription: '角色描述',
        charPersonality: '角色性格',
        scenario: '场景',
        personaDescription: '用户人设',
        chatHistory: '聊天记录',
        dialogueExamples: '示例消息',
        authorsNote: '作者注释',
        summary: '记忆摘要',
    };
    if (names[identifier]) return names[identifier];
    if (identifier.startsWith('chatHistory-')) return `聊天消息 ${identifier.slice(12)}`;
    return identifier;
}

function isProtocolMessage(message) {
    return message?.role === 'tool' || Array.isArray(message?.tool_calls);
}

function stableHash(value) {
    let hash = 2166136261;
    for (const character of String(value)) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}
