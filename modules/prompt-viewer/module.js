import { renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { waitForElement } from '../platform/dom.js';
import { EXTENSION_ID } from '../platform/extension-identity.js';
import { PromptViewerCapture } from './capture.js';
import { PromptViewerStore } from './store.js';
import { PromptViewerUi } from './ui.js';

/**
 * 装配提示词主动预览、正式请求捕获与只读查看面板
 */
export class PromptViewerModule {
    constructor({ toolboxSettings }) {
        this.settings = toolboxSettings.modules.promptViewer;
        this.getContext = () => SillyTavern.getContext();
        this.bindings = [];
        this.eventsBound = false;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;
        await waitForElement('#send_form');
        const template = await renderExtensionTemplateAsync(
            EXTENSION_ID,
            'templates/prompt-viewer/panel',
        );
        this.store = new PromptViewerStore();
        this.capture = new PromptViewerCapture({
            getContext: this.getContext,
            store: this.store,
        });
        this.ui = new PromptViewerUi({
            template,
            store: this.store,
            refresh: () => this.capture.requestRefresh(),
        });
        this.ui.initialize();
        this.#prepareEvents();
        this.initialized = true;
    }

    setEnabled(enabled) {
        if (!this.initialized) return;
        this.capture.setEnabled(enabled);
        this.ui.setFloatingMode(this.settings.floatingBubble !== false);
        this.ui.setEnabled(enabled);
        this.#setEventsEnabled(enabled);
        if (!enabled) this.store.clear();
    }

    #prepareEvents() {
        const context = this.getContext();
        const events = context.eventTypes;
        this.eventSource = context.eventSource;
        this.#addEvent(events.CHAT_COMPLETION_SETTINGS_READY, payload => {
            void this.capture.captureChat(payload).catch(error => {
                this.store.setError(error instanceof Error ? error.message : String(error));
                console.error('[酒馆工具箱] 捕获聊天补全提示词失败', error);
            });
        });
        this.#addEvent(events.GENERATION_STARTED, (_type, _options, dryRun) => {
            this.capture.handleGenerationStarted(dryRun);
        });
        this.#addEvent(events.GENERATE_AFTER_DATA, (payload, dryRun) => {
            void this.capture.captureText(payload, dryRun).catch(error => {
                this.store.setError(error instanceof Error ? error.message : String(error));
                console.error('[酒馆工具箱] 捕获文本补全提示词失败', error);
            });
        });
        this.#addEvent(events.CHAT_CHANGED, () => this.store.clear());
    }

    #addEvent(eventType, handler) {
        if (eventType) this.bindings.push([eventType, handler]);
    }

    #setEventsEnabled(enabled) {
        if (enabled === this.eventsBound) return;
        this.eventsBound = enabled;
        for (const [eventType, handler] of this.bindings) {
            if (enabled) this.eventSource.on(eventType, handler);
            else this.eventSource.removeListener(eventType, handler);
        }
    }
}
