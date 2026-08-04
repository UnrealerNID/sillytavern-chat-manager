import { renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { getRegexedString, regex_placement } from '/scripts/extensions/regex/engine.js';
import { DEFAULT_DEPTH, world_info_position } from '/scripts/world-info.js';
import { saveSettingsDebounced } from '/script.js';

import { waitForElement } from '../platform/dom.js';
import { EXTENSION_ID } from '../platform/extension-identity.js';
import { WorldInfoScanner } from './scanner.js';
import { WorldInfoControlStore, getWorldInfoControlChatKey } from './store.js';
import { WorldInfoControlUi } from './ui.js';
import { WorldInfoPromptAdapter } from './world-info.js';

/**
 * 装配世界书实时扫描、持久关闭与输入区面板
 */
export class WorldInfoControlModule {
    constructor({ toolboxSettings }) {
        this.settings = toolboxSettings.modules.worldInfoControl;
        this.getContext = () => SillyTavern.getContext();
        this.enabled = false;
        this.initialized = false;
        this.eventsBound = false;
        this.bindings = [];
    }

    async initialize() {
        if (this.initialized) return;
        await waitForElement('#send_form');
        const template = await renderExtensionTemplateAsync(
            EXTENSION_ID,
            'templates/world-info-control/panel',
        );
        this.store = new WorldInfoControlStore({
            exclusions: this.settings.exclusions,
            onExclusionsChange: exclusions => {
                this.settings.exclusions = exclusions;
                saveSettingsDebounced();
            },
        });
        this.adapter = new WorldInfoPromptAdapter({
            store: this.store,
            processEntry: entry => getRegexedString(
                entry.content,
                regex_placement.WORLD_INFO,
                {
                    depth: entry.position === world_info_position.atDepth
                        ? (entry.depth ?? DEFAULT_DEPTH)
                        : null,
                    isMarkdown: false,
                    isPrompt: true,
                },
            ),
        });
        this.scanner = new WorldInfoScanner({
            getContext: this.getContext,
            store: this.store,
            adapter: this.adapter,
        });
        this.ui = new WorldInfoControlUi({
            template,
            store: this.store,
            refresh: () => this.scanner.refresh(),
        });
        this.ui.initialize();
        this.#prepareEvents();
        this.#bindInput();
        this.initialized = true;
    }

    setEnabled(enabled) {
        if (!this.initialized) return;
        this.enabled = enabled;
        this.scanner.setEnabled(enabled);
        this.ui.setEnabled(enabled);
        this.#setEventsEnabled(enabled);
        if (enabled) this.#syncChat();
        else {
            this.adapter.reset();
            this.store.resetRuntime();
        }
    }

    #prepareEvents() {
        const context = this.getContext();
        const events = context.eventTypes;
        this.eventSource = context.eventSource;
        this.#addEvent(events.WORLDINFO_ENTRIES_LOADED, payload => {
            this.adapter.filterLoadedEntries(payload);
        });
        this.#addEvent(events.WORLDINFO_SCAN_DONE, payload => {
            this.adapter.captureActivatedEntries(payload);
            void this.scanner.syncFromAdapter({
                complete: !this.scanner.isScanning(),
            }).catch(error => {
                console.error('[酒馆工具箱] 同步世界书扫描结果失败', error);
            });
        });
        this.#addEvent(events.CHAT_CHANGED, () => {
            this.adapter.reset();
            this.#syncChat();
            this.ui.scheduleRefresh();
        });
        for (const eventType of [
            events.MESSAGE_EDITED,
            events.MESSAGE_DELETED,
            events.MESSAGE_UPDATED,
            events.CHARACTER_EDITED,
            events.WORLDINFO_UPDATED,
        ]) {
            this.#addEvent(eventType, () => this.ui.scheduleRefresh());
        }
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

    #bindInput() {
        document.querySelector('#send_textarea')?.addEventListener(
            'input',
            () => this.ui.scheduleRefresh(),
        );
    }

    #syncChat() {
        const context = this.getContext();
        this.store.setChatKey(getWorldInfoControlChatKey(context));
        this.store.setStatus('stale');
    }
}
