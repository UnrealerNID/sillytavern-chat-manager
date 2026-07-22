import { element } from '../shared/dom.js';

const BRIDGE_KEY = 'TavernToolboxPromptControl';
const CHANGE_EVENT = 'tavern-toolbox:prompt-control-changed';
const VIEWER_TITLES = new Set(['提示词查看器', 'Prompt Viewer']);

/**
 * 在酒馆助手原提示词查看器中增加结构视图，并提供共享控制桥
 */
export class TavernHelperPromptIntegration {
    /**
     * @param {object} options 配置项
     * @param {import('./snapshot.js').PromptSnapshotStore} options.store 快照状态
     * @param {()=>Promise<void>} options.refresh 刷新回调
     * @param {(container:HTMLElement,view:string)=>void} options.renderView 结构视图渲染器
     */
    constructor({ store, refresh, renderView }) {
        this.store = store;
        this.refresh = refresh;
        this.renderView = renderView;
        this.mounts = new Set();
        this.unsubscribe = null;
        this.observer = null;
        this.bridge = null;
    }

    setEnabled(enabled) {
        if (!enabled) {
            this.dispose();
            return;
        }
        if (this.observer) return;
        this.#installBridge();
        this.unsubscribe = this.store.subscribe(() => {
            this.#publish();
            this.#renderMounts();
        });
        this.observer = new MutationObserver(() => this.#scan());
        this.observer.observe(document.body, { childList: true, subtree: true });
        this.#scan();
    }

    dispose() {
        this.observer?.disconnect();
        this.observer = null;
        this.unsubscribe?.();
        this.unsubscribe = null;
        for (const mount of this.mounts) this.#removeMount(mount);
        this.mounts.clear();
        if (globalThis[BRIDGE_KEY] === this.bridge) delete globalThis[BRIDGE_KEY];
        this.bridge = null;
    }

    #installBridge() {
        this.bridge = Object.freeze({
            getSnapshot: () => structuredClone(this.store.getSnapshot()),
            getExclusions: () => Array.from(this.store.getExclusions()),
            setExcluded: (controlId, excluded) => this.store.setExcluded(controlId, excluded),
            clear: () => this.store.clearCurrent(),
            refresh: () => this.refresh(),
            changeEvent: CHANGE_EVENT,
        });
        globalThis[BRIDGE_KEY] = this.bridge;
    }

    #publish() {
        document.dispatchEvent(new CustomEvent(CHANGE_EVENT, {
            detail: { snapshot: structuredClone(this.store.getSnapshot()) },
        }));
    }

    #scan() {
        for (const mount of this.mounts) {
            if (!mount.dialog.isConnected) this.mounts.delete(mount);
        }
        for (const dialog of document.querySelectorAll('[role="dialog"]')) {
            if (!(dialog instanceof HTMLElement)) continue;
            if (dialog.dataset.toolboxPromptEnhanced === 'true') continue;
            const mount = this.#createMount(dialog);
            if (mount) this.mounts.add(mount);
        }
    }

    #createMount(dialog) {
        // 酒馆助手弹窗带有稳定的根类名，避免误挂载到同名的其他弹窗
        if (!dialog.classList.contains('TH-custom-tailwind')) return null;
        const header = dialog.firstElementChild;
        const body = dialog.children[1];
        const title = header?.firstElementChild?.textContent?.trim();
        if (!VIEWER_TITLES.has(title)) return null;
        if (!(body instanceof HTMLElement) || !(body.firstElementChild instanceof HTMLElement)) return null;
        const original = body.firstElementChild;
        const tabs = element('nav', {
            className: 'prompt-control-tabs prompt-control-helper-tabs',
            attrs: { 'aria-label': '提示词查看方式' },
        });
        const enhanced = element('div', {
            className: 'prompt-control-content prompt-control-helper-content',
        });
        enhanced.hidden = true;
        const mount = { dialog, body, original, tabs, enhanced, view: 'prompt' };
        for (const [view, label] of [
            ['prompt', '最终提示词'],
            ['source', '来源分类'],
        ]) {
            const button = element('button', {
                className: view === 'prompt' ? 'selected' : '',
                text: label,
                type: 'button',
                attrs: { 'data-prompt-helper-view': view },
            });
            button.addEventListener('click', () => this.#selectView(mount, view));
            tabs.append(button);
        }
        body.prepend(tabs);
        body.append(enhanced);
        dialog.dataset.toolboxPromptEnhanced = 'true';
        return mount;
    }

    #selectView(mount, view) {
        mount.view = view;
        mount.original.hidden = view !== 'prompt';
        mount.enhanced.hidden = view === 'prompt';
        for (const button of mount.tabs.querySelectorAll('[data-prompt-helper-view]')) {
            button.classList.toggle('selected', button.dataset.promptHelperView === view);
        }
        if (view !== 'prompt') {
            this.renderView(mount.enhanced, view);
            if (this.store.getStatus() !== 'ready') void this.refresh();
        }
    }

    #renderMounts() {
        for (const mount of this.mounts) {
            if (mount.view !== 'prompt' && mount.dialog.isConnected) {
                this.renderView(mount.enhanced, mount.view);
            }
        }
    }

    #removeMount(mount) {
        mount.original.hidden = false;
        mount.tabs.remove();
        mount.enhanced.remove();
        delete mount.dialog.dataset.toolboxPromptEnhanced;
    }
}
