import { getImageSizeFromDataURL } from '/scripts/utils.js';
import {
    Generate,
    getBiasStrings,
    is_send_press,
    name1,
    online_status,
    removeMacros,
    stopGeneration,
    substituteParams,
} from '/script.js';
import {
    getRegexedString,
    regex_placement,
} from '/scripts/extensions/regex/engine.js';
import { getMessageTimeStamp } from '/scripts/RossAscends-mods.js';

import {
    createChatSnapshot,
    createTextSnapshot,
} from '../prompt-common/snapshot.js';
import { countPromptMessageTokens } from '../prompt-common/token-counter.js';

/**
 * 捕获请求提示词，并支持在真正发送前主动预览
 */
export class PromptViewerCapture {
    constructor({ getContext, store }) {
        this.getContext = getContext;
        this.store = store;
        this.enabled = false;
        this.previewing = false;
        this.revision = 0;
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled && this.previewing) {
            this.previewing = false;
            stopGeneration();
        }
    }

    /**
     * 触发一次不新增用户消息的生成流程，并在请求发出前截获提示词
     * @returns {Promise<void>} 预览流程
     */
    async requestRefresh() {
        if (!this.enabled || this.previewing) return;
        if (online_status === 'no_connection') {
            throw new Error('尚未连接 API，无法主动获取提示词');
        }
        if (is_send_press) {
            throw new Error('当前正在生成，请等待生成结束后刷新');
        }

        this.previewing = true;
        this.store.setLoading();
        let draft = null;
        try {
            draft = this.#stageDraft();
            await Generate('normal', { automatic_trigger: true });
            if (this.previewing) {
                this.previewing = false;
                this.store.setError('未能截获本轮提示词');
            }
        } catch (error) {
            // 捕获完成后的主动中止属于正常流程
            if (!this.previewing) return;
            this.previewing = false;
            this.store.setError(error instanceof Error ? error.message : String(error));
            throw error;
        } finally {
            this.#restoreDraft(draft);
        }
    }

    /**
     * 将输入框草稿临时加入内存上下文，避免 Generate 保存真实用户消息
     * @returns {object|null} 草稿恢复信息
     */
    #stageDraft() {
        const textarea = document.querySelector('#send_textarea');
        const chat = this.getContext().chat;
        if (!(textarea instanceof HTMLTextAreaElement) || !Array.isArray(chat) || !textarea.value) {
            return null;
        }

        const text = textarea.value;
        const selectionStart = textarea.selectionStart;
        const selectionEnd = textarea.selectionEnd;
        const { messageBias } = getBiasStrings(text, 'normal');
        const message = {
            name: name1,
            is_user: true,
            is_system: false,
            send_date: getMessageTimeStamp(),
            mes: substituteParams(getRegexedString(text, regex_placement.USER_INPUT)),
            extra: {},
        };
        if (messageBias) {
            message.extra.bias = messageBias;
            message.mes = removeMacros(message.mes);
        }

        chat.push(message);
        textarea.value = '';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        return { textarea, chat, message, text, selectionStart, selectionEnd };
    }

    /**
     * 移除临时消息并原样恢复输入框草稿
     * @param {object|null} draft 草稿恢复信息
     */
    #restoreDraft(draft) {
        if (!draft) return;
        const index = draft.chat.lastIndexOf(draft.message);
        if (index >= 0) draft.chat.splice(index, 1);
        const textEnteredDuringPreview = draft.textarea.value;
        draft.textarea.value = draft.text + textEnteredDuringPreview;
        if (!textEnteredDuringPreview) {
            draft.textarea.setSelectionRange(draft.selectionStart, draft.selectionEnd);
        }
        draft.textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    handleGenerationStarted(dryRun) {
        if (!this.enabled || dryRun === true || this.previewing) return;
        this.store.setLoading();
    }

    async captureChat(payload) {
        const previewing = this.previewing;
        if (previewing) {
            this.previewing = false;
            stopGeneration();
        }
        if (!this.enabled || !Array.isArray(payload?.messages)) return;
        const revision = ++this.revision;
        const context = this.getContext();
        const snapshot = await createChatSnapshot({
            chat: payload.messages,
            countMessageTokens: message => countPromptMessageTokens(
                message,
                text => context.getTokenCountAsync(text),
                getImageSizeFromDataURL,
            ),
        });
        if (revision === this.revision) this.store.setSnapshot(snapshot);
    }

    async captureText(payload, dryRun) {
        if (!this.enabled || dryRun === true || typeof payload?.prompt !== 'string') return;
        if (this.previewing) {
            this.previewing = false;
            stopGeneration();
        }
        const revision = ++this.revision;
        const context = this.getContext();
        const snapshot = await createTextSnapshot({
            prompt: payload.prompt,
            countTokens: text => context.getTokenCountAsync(text),
        });
        if (revision === this.revision) this.store.setSnapshot(snapshot);
    }
}
