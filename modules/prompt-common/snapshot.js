import { countPromptMessageTokens } from './token-counter.js';

/**
 * 将聊天补全请求转换为只读快照
 * @param {object} options 配置项
 * @param {object[]} options.chat 最终消息数组
 * @param {(message:object)=>Promise<number>} [options.countMessageTokens] 消息 Token 计算器
 * @returns {Promise<object>} 最终提示词快照
 */
export async function createChatSnapshot({
    chat,
    countMessageTokens = message => countPromptMessageTokens(message, async text => text.length),
}) {
    const finalNodes = await Promise.all(chat.map(async (message, index) => ({
        id: `final:${stableHash(`${index}:${message.role}:${promptContentToText(message.content)}`)}`,
        sendIndex: index,
        role: message.role ?? 'unknown',
        content: promptContentToText(message.content),
        tokenCount: await countMessageTokens(message),
    })));
    return {
        api: 'chat-completion',
        capturedAt: Date.now(),
        finalNodes,
        totalTokens: finalNodes.reduce((total, node) => total + node.tokenCount, 0),
    };
}

/**
 * 将文本补全请求转换为只读快照
 * @param {object} options 配置项
 * @param {string} options.prompt 最终提示词
 * @param {(text:string)=>Promise<number>} options.countTokens Token 计算器
 * @returns {Promise<object>} 最终提示词快照
 */
export async function createTextSnapshot({ prompt, countTokens }) {
    const content = String(prompt ?? '');
    const node = {
        id: `final:${stableHash(content)}`,
        sendIndex: 0,
        role: 'prompt',
        content,
        tokenCount: await countTokens(content),
    };
    return {
        api: 'text-completion',
        capturedAt: Date.now(),
        finalNodes: [node],
        totalTokens: node.tokenCount,
    };
}

export function promptContentToText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return String(content ?? '');
    return content.map(part => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return String(part.text ?? '');
        if (part?.type === 'image_url') return '[图片]';
        if (part?.type === 'video_url') return '[视频]';
        return JSON.stringify(part);
    }).join('\n');
}

function stableHash(value) {
    let hash = 2166136261;
    for (const character of String(value)) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}
