import { renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { promptManager } from '/scripts/openai.js';

import { waitForElement } from '../platform/dom.js';
import { EXTENSION_ID } from '../platform/extension-identity.js';
import { PromptCaptureController } from './capture.js';
import { PromptSnapshotStore, getPromptChatKey } from './snapshot.js';
import { TavernHelperPromptIntegration } from './tavern-helper.js';
import { PromptControlUi } from './ui.js';
import { WorldInfoPromptAdapter } from './world-info.js';

/**
 * 装配本轮提示词捕获、控制、面板与兼容桥
 */
export class PromptControlModule {
    /**
     * @param {object} options 配置项
     * @param {object} options.toolboxSettings 工具箱完整设置
     */
    constructor({ toolboxSettings }) {
        this.settings = toolboxSettings.modules.promptControl;
        this.getContext = () => SillyTavern.getContext();
        this.enabled = false;
        this.initialized = false;
        this.eventsBound = false;
        this.eventBindings = [];
        this.inputController = null;
    }

    /**
     * 创建运行时、静态面板和事件映射
     * @returns {Promise<void>} 初始化完成
     */
    async initialize() {
        if (this.initialized) return;
        await waitForElement('#send_form');
        const template = await renderExtensionTemplateAsync(
            EXTENSION_ID,
            'templates/prompt-control/panel',
        );
        this.store = new PromptSnapshotStore();
        this.worldInfo = new WorldInfoPromptAdapter({ store: this.store });
        this.capture = new PromptCaptureController({
            getContext: this.getContext,
            getStructuredMessages: () => promptManager?.messages ?? null,
            store: this.store,
            worldInfo: this.worldInfo,
        });
        this.ui = new PromptControlUi({
            template,
            store: this.store,
            refresh: () => this.capture.refresh(),
        });
        this.bridge = new TavernHelperPromptIntegration({
            store: this.store,
            refresh: () => this.capture.refresh(),
            renderView: (container, view) => this.ui.renderInto(container, view),
        });
        this.ui.initialize();
        this.#prepareEventBindings();
        this.#bindInput();
        this.initialized = true;
    }

    /**
     * 同步模块总状态与酒馆助手兼容桥状态
     * @param {boolean} enabled 是否启用
     */
    setEnabled(enabled) {
        if (!this.initialized) return;
        this.enabled = enabled;
        this.ui.setFloatingMode(this.settings.floatingBubble !== false);
        this.capture.setEnabled(enabled);
        this.ui.setEnabled(enabled);
        this.#setEventsEnabled(enabled);
        this.bridge.setEnabled(enabled && this.settings.tavernHelper !== false);
        if (enabled) this.#syncChat();
        else {
            this.worldInfo.reset();
            this.store.clearAll();
        }
    }

    #prepareEventBindings() {
        const context = this.getContext();
        const events = context.eventTypes;
        this.eventSource = context.eventSource;
        this.#addBinding(events.CHAT_COMPLETION_PROMPT_READY, payload => {
            return this.capture.captureChat(payload);
        });
        this.#addBinding(events.GENERATE_BEFORE_COMBINE_PROMPTS, payload => {
            this.capture.captureTextParts(payload);
        });
        this.#addBinding(events.GENERATE_AFTER_COMBINE_PROMPTS, payload => {
            return this.capture.captureText(payload);
        });
        this.#addBinding(events.WORLDINFO_ENTRIES_LOADED, payload => {
            this.worldInfo.filterLoadedEntries(payload);
        });
        this.#addBinding(events.WORLDINFO_SCAN_DONE, payload => {
            this.worldInfo.captureActivatedEntries(payload);
        });
        this.#addBinding(events.CHAT_CHANGED, () => this.#handleChatChanged());
        for (const eventType of [
            events.MESSAGE_EDITED,
            events.MESSAGE_DELETED,
            events.MESSAGE_UPDATED,
            events.CHARACTER_EDITED,
            events.WORLDINFO_UPDATED,
            events.OAI_PRESET_CHANGED_AFTER,
        ]) {
            this.#addBinding(eventType, () => this.ui.scheduleRefresh());
        }
    }

    #addBinding(eventType, handler) {
        if (eventType) this.eventBindings.push([eventType, handler]);
    }

    #setEventsEnabled(enabled) {
        if (enabled === this.eventsBound) return;
        this.eventsBound = enabled;
        for (const [eventType, handler] of this.eventBindings) {
            if (enabled) this.eventSource.on(eventType, handler);
            else this.eventSource.removeListener(eventType, handler);
        }
    }

    #bindInput() {
        this.inputController?.abort();
        this.inputController = new AbortController();
        const textarea = document.querySelector('#send_textarea');
        textarea?.addEventListener('input', () => this.ui.scheduleRefresh(), {
            signal: this.inputController.signal,
        });
    }

    #syncChat() {
        const context = this.getContext();
        this.store.setChatKey(getPromptChatKey(context));
        this.capture.markStale();
    }

    #handleChatChanged() {
        this.worldInfo.reset();
        this.#syncChat();
        this.ui.scheduleRefresh();
    }
}
