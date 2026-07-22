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
     * @param {(identifier:string)=>string} options.getPromptName 预设条目名称读取器
     * @param {import('./snapshot.js').PromptSnapshotStore} options.store 快照状态
     * @param {import('./world-info.js').WorldInfoPromptAdapter} options.worldInfo 世界书适配器
     */
    constructor({ getContext, getStructuredMessages, getPromptName, store, worldInfo }) {
        this.getContext = getContext;
        this.getStructuredMessages = getStructuredMessages;
        this.getPromptName = getPromptName;
        this.store = store;
        this.worldInfo = worldInfo;
        this.enabled = false;
        this.refreshTask = null;
        this.textParts = [];
        this.captureRevision = 0;
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) {
            this.refreshTask = null;
        }
    }

    /**
     * 标记当前预览已过期
     */
    markStale() {
        if (this.enabled) this.store.setStatus('stale');
    }

    /**
     * 使用酒馆原生 dry-run 独立装配预览
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
        this.refreshTask = this.#runPreview(context).catch(error => {
            this.store.setStatus('error');
            console.error('[酒馆工具箱] 刷新本轮提示词失败', error);
            throw error;
        }).finally(() => {
            this.refreshTask = null;
        });
        return this.refreshTask;
    }

    /**
     * 在加载态完成绘制后执行一次不发送请求的提示词装配
     * @param {object} context 酒馆上下文
     * @returns {Promise<void>} 装配完成
     */
    async #runPreview(context) {
        // 先让加载态完成一帧绘制，再开始可能耗时的提示词装配
        await waitForUiPaint();
        await context.generate('normal', {}, true);
        if (this.store.getStatus() === 'loading') {
            throw new Error('酒馆未返回可用的提示词预览');
        }
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
            getPromptName: this.getPromptName,
        });
        // 正式发送的排除不受同时进行的预览渲染版本影响
        if (payload.dryRun !== true) this.#applyFinalExclusions(payload.chat, snapshot);
        if (revision !== this.captureRevision) return;
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
        addTextPart(parts, 'scenario', 'scenario', '场景', payload?.scenario);
        addTextPart(parts, 'persona', 'persona', '用户人设', payload?.persona);
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
            worldEntries: this.worldInfo.getActivatedEntries(),
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

/**
 * 等待浏览器绘制下一帧
 * @returns {Promise<void>} 下一帧开始时完成
 */
function waitForUiPaint() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}
