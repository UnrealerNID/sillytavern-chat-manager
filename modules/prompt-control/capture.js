import {
    createChatSnapshot,
    createTextSnapshot,
    getPromptChatKey,
} from './snapshot.js';
import { countPromptMessageTokens } from './token-counter.js';
import { getImageSizeFromDataURL } from '/scripts/utils.js';

/**
 * 捕获预览与正式发送提示词，并应用安全的最终消息排除
 */
export class PromptCaptureController {
    /**
     * @param {object} options 配置项
     * @param {()=>object} options.getContext 酒馆上下文读取器
     * @param {()=>object|null} options.getStructuredMessages 结构化消息读取器
     * @param {import('./snapshot.js').PromptSnapshotStore} options.store 快照状态
     * @param {import('./world-info.js').WorldInfoPromptAdapter} options.worldInfo 世界书适配器
     */
    constructor({ getContext, getStructuredMessages, store, worldInfo }) {
        this.getContext = getContext;
        this.getStructuredMessages = getStructuredMessages;
        this.store = store;
        this.worldInfo = worldInfo;
        this.enabled = false;
        this.refreshTask = null;
        this.textParts = [];
        this.captureRevision = 0;
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) this.refreshTask = null;
    }

    /**
     * 标记当前预览已过期
     */
    markStale() {
        if (this.enabled) this.store.setStatus('stale');
    }

    /**
     * 使用酒馆原生干跑生成刷新预览
     * @returns {Promise<void>} 刷新完成
     */
    async refresh() {
        if (!this.enabled) return;
        if (this.refreshTask) return this.refreshTask;
        const context = this.getContext();
        this.store.setChatKey(getPromptChatKey(context));
        if (context.characterId === undefined && !context.groupId) {
            this.store.setStatus('idle');
            return;
        }
        this.store.setStatus('loading');
        this.refreshTask = context.generate('normal', {}, true).then(() => {
            if (this.store.getStatus() === 'loading') this.store.setStatus('ready');
        }).catch(error => {
            this.store.setStatus('error');
            console.error('[酒馆工具箱] 刷新本轮提示词失败', error);
            throw error;
        }).finally(() => {
            this.refreshTask = null;
        });
        return this.refreshTask;
    }

    /**
     * 捕获聊天补全最终消息，并在正式发送时应用临时排除
     * @param {object} payload 发送前事件参数
     * @returns {Promise<void>} 捕获完成
     */
    async captureChat(payload) {
        if (!this.enabled || !Array.isArray(payload?.chat)) return;
        const revision = ++this.captureRevision;
        const context = this.getContext();
        this.store.setChatKey(getPromptChatKey(context));
        const snapshot = await createChatSnapshot({
            chat: payload.chat,
            messages: this.getStructuredMessages(),
            countTokens: text => context.getTokenCountAsync(text),
            countMessageTokens: message => countPromptMessageTokens(
                message,
                text => context.getTokenCountAsync(text),
                getImageSizeFromDataURL,
            ),
            dryRun: payload.dryRun === true,
            worldEntries: this.worldInfo.getActivatedEntries(),
        });
        if (revision !== this.captureRevision) return;
        this.#applyFinalExclusions(payload.chat, snapshot);
        this.#markExcluded(snapshot);
        this.store.setSnapshot(snapshot);
        this.store.setStatus('ready');
    }

    /**
     * 捕获文本补全合并前结构
     * @param {object} payload 合并前事件参数
     */
    captureTextParts(payload) {
        if (!this.enabled) return;
        const parts = [];
        addTextPart(parts, 'main', 'preset', '主提示词', payload?.main);
        addTextPart(parts, 'world-before', 'worldInfo', '角色定义前世界书', payload?.worldInfoBefore);
        addTextPart(parts, 'description', 'character', '角色描述', payload?.description);
        addTextPart(parts, 'personality', 'character', '角色性格', payload?.personality);
        addTextPart(parts, 'scenario', 'character', '场景', payload?.scenario);
        addTextPart(parts, 'persona', 'character', '用户人设', payload?.persona);
        addTextPart(parts, 'world-after', 'worldInfo', '角色定义后世界书', payload?.worldInfoAfter);
        addTextPart(parts, 'examples', 'example', '示例消息', payload?.mesExmString);
        for (const [index, message] of (payload?.finalMesSend ?? []).entries()) {
            const injections = Array.isArray(message.extensionPrompts)
                ? message.extensionPrompts.join('')
                : '';
            addTextPart(
                parts,
                `chat-${index}`,
                message.injected ? 'extension' : 'chat',
                message.injected ? `注入消息 ${index + 1}` : `聊天消息 ${index + 1}`,
                `${injections}${message.message ?? ''}`,
            );
        }
        addTextPart(parts, 'jailbreak', 'preset', '后置提示词', payload?.jailbreak);
        this.textParts = parts;
    }

    /**
     * 捕获文本补全最终字符串
     * @param {object} payload 合并后事件参数
     * @returns {Promise<void>} 捕获完成
     */
    async captureText(payload) {
        if (!this.enabled || typeof payload?.prompt !== 'string') return;
        const revision = ++this.captureRevision;
        const context = this.getContext();
        this.store.setChatKey(getPromptChatKey(context));
        const snapshot = await createTextSnapshot({
            prompt: payload.prompt,
            countTokens: text => context.getTokenCountAsync(text),
            dryRun: payload.dryRun === true,
            parts: this.textParts,
        });
        if (revision !== this.captureRevision) return;
        this.#markExcluded(snapshot);
        this.store.setSnapshot(snapshot);
        this.store.setStatus('ready');
    }

    #applyFinalExclusions(chat, snapshot) {
        for (let index = snapshot.finalNodes.length - 1; index >= 0; index -= 1) {
            const node = snapshot.finalNodes[index];
            if (node.controlLevel === 'locked' || !this.store.isExcluded(node.id)) continue;
            chat.splice(index, 1);
        }
    }

    #markExcluded(snapshot) {
        for (const node of snapshot.finalNodes) node.excluded = this.store.isExcluded(node.id);
        for (const item of snapshot.contributions) {
            item.excluded = item.controlId ? this.store.isExcluded(item.controlId) : false;
        }
        snapshot.totalTokens = snapshot.finalNodes
            .filter(node => !node.excluded)
            .reduce((total, node) => total + node.tokenCount, 0);
    }
}

function addTextPart(parts, id, sourceType, sourceName, content) {
    if (!content) return;
    parts.push({ id, sourceType, sourceName, content: String(content) });
}
