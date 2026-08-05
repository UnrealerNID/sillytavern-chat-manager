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
        this.initialized = false;
        this.eventsBound = false;
        this.bindings = [];
        this.generationActive = false;
        this.generationHasScan = false;
        this.generationChatKey = '';
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
            refresh: () => this.generationActive
                ? Promise.resolve()
                : this.scanner.refresh(),
        });
        this.ui.initialize();
        this.#prepareEvents();
        this.initialized = true;
    }

    setEnabled(enabled) {
        if (!this.initialized) return;
        this.scanner.setEnabled(enabled);
        this.ui.setEnabled(enabled);
        this.#setEventsEnabled(enabled);
        if (enabled) this.#syncChat();
        else {
            this.#resetGeneration();
            this.adapter.reset();
            this.store.resetRuntime();
        }
    }

    #prepareEvents() {
        const context = this.getContext();
        const events = context.eventTypes;
        this.eventSource = context.eventSource;
        this.#addEvent(events.WORLDINFO_ENTRIES_LOADED, payload => {
            this.adapter.filterLoadedEntries(payload, {
                applyExclusions: this.generationActive || !this.scanner.isPreviewActive(),
            });
        });
        this.#addEvent(events.WORLDINFO_SCAN_DONE, payload => {
            this.adapter.captureActivatedEntries(payload);
            if (this.generationActive) this.generationHasScan = true;
        });
        this.#addEvent(events.GENERATION_STARTED, (...args) => this.#startGeneration(args.at(-1)));
        this.#addEvent(events.GENERATION_ENDED, () => this.#finishGeneration());
        this.#addEvent(events.GENERATION_STOPPED, () => this.#finishGeneration());
        this.#addEvent(events.CHAT_CHANGED, () => {
            this.#resetGeneration();
            this.scanner.interrupt();
            this.adapter.reset();
            this.ui.setOpen(false);
            this.#syncChat();
        });
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

    #startGeneration(dryRun) {
        if (dryRun === true) return;
        this.generationActive = true;
        this.generationHasScan = false;
        this.generationChatKey = getWorldInfoControlChatKey(this.getContext());
        this.scanner.interrupt();
        this.adapter.reset();
        this.store.setStatus(this.store.hasSnapshot() ? 'scanning' : 'loading');
    }

    #finishGeneration() {
        if (!this.generationActive) return;
        const expectedChatKey = this.generationChatKey;
        const hasScan = this.generationHasScan;
        this.#resetGeneration();
        if (!hasScan) {
            this.store.setStatus(this.store.hasSnapshot() ? 'ready' : 'stale');
            return;
        }
        void this.scanner
            .syncFromAdapter({ expectedChatKey, preserveExcluded: true })
            .catch(error => {
                console.error('[酒馆工具箱] 同步真实发送的世界书结果失败', error);
            });
    }

    #resetGeneration() {
        this.generationActive = false;
        this.generationHasScan = false;
        this.generationChatKey = '';
    }

    #syncChat() {
        const context = this.getContext();
        this.store.setChatKey(getWorldInfoControlChatKey(context));
        this.store.setStatus('stale');
    }
}
