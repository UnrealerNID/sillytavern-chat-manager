import { element } from '../shared/dom.js';
import { groupWorldInfoSections } from './order.js';
import { worldControlId } from './world-info.js';

const PANEL_HEIGHT_KEY = 'sillytavern-toolbox:world-info-control-height';
const MIN_PANEL_HEIGHT = 180;

/**
 * 管理输入区上方的世界书控制面板
 */
export class WorldInfoControlUi {
    constructor({ template, store, refresh }) {
        this.template = template;
        this.store = store;
        this.refresh = refresh;
        this.enabled = false;
        this.opened = false;
        this.groupStates = new Map();
    }

    initialize() {
        const holder = document.createElement('template');
        holder.innerHTML = this.template.trim();
        this.root = holder.content.firstElementChild;
        if (!(this.root instanceof HTMLElement)) throw new Error('世界书控制模板结构无效');
        this.panel = requireElement(this.root, '[data-world-info-control-panel]');
        this.body = requireElement(this.root, '[data-world-info-control-body]');
        this.toggleButton = requireButton(this.root, '[data-world-info-control-toggle]');
        this.indicator = requireElement(this.root, '[data-world-info-control-indicator]');
        this.resizeHandle = requireElement(this.root, '[data-world-info-control-resize]');
        this.content = requireElement(this.root, '[data-world-info-control-content]');
        this.summary = requireElement(this.root, '[data-world-info-control-summary]');
        this.search = requireInput(this.root, '[data-world-info-control-search]');
        this.refreshButton = requireButton(this.root, '[data-world-info-control-refresh]');
        this.clearButton = requireButton(this.root, '[data-world-info-control-clear]');
        const form = document.querySelector('#send_form');
        if (!(form instanceof HTMLElement)) throw new Error('未找到酒馆输入区');
        form.classList.add('world-info-control-anchor');
        form.append(this.root);
        this.#restoreHeight();
        this.#bindEvents();
        // 条目开关只同步现有节点，避免在表单事件中重建整个列表
        this.store.subscribe(change => {
            if (change === 'exclusions') this.#syncExclusionState();
            else if (change === 'tokens') this.#syncTokenCounts();
            else this.render();
        });
        this.render();
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        this.root?.classList.toggle('displayNone', !enabled);
        if (!enabled) this.setOpen(false);
    }

    setOpen(opened) {
        this.opened = Boolean(opened && this.enabled);
        this.body.hidden = !this.opened;
        this.panel.classList.toggle('world-info-control-open', this.opened);
        this.toggleButton.setAttribute('aria-expanded', String(this.opened));
        this.toggleButton.title = this.opened ? '收起世界书控制' : '展开世界书控制';
        this.indicator.classList.toggle('fa-chevron-up', !this.opened);
        this.indicator.classList.toggle('fa-chevron-down', this.opened);
        this.ensureSnapshot();
    }

    /**
     * 仅在当前聊天尚无快照且面板可见时执行首次扫描
     */
    ensureSnapshot() {
        if (this.enabled && this.opened && !this.store.hasSnapshot()) void this.#refresh();
    }

    render() {
        if (!this.content) return;
        const status = this.store.getStatus();
        const entries = this.store.getEntries();
        const excluded = this.store.getRelevantExclusions();
        this.refreshButton.disabled = status === 'loading' || status === 'scanning';
        this.#updateSummary(entries.length, excluded.size, status);
        this.content.replaceChildren();
        if (status === 'loading' || (status === 'scanning' && !entries.length)) {
            this.content.append(createState('fa-circle-notch', '正在扫描世界书…', true));
            return;
        }
        if (status !== 'ready' && status !== 'scanning') {
            const text = status === 'idle'
                ? '选择角色或群聊后可扫描'
                : status === 'error'
                ? '扫描失败，不影响正常发送'
                : '打开或刷新以扫描当前上下文';
            this.content.append(createState('fa-book-open', text));
            return;
        }

        const query = this.search.value.trim().toLocaleLowerCase();
        const visible = entries.filter(entry => matchesEntry(entry, query));
        if (!visible.length) {
            this.content.append(createState('fa-magnifying-glass', query ? '没有匹配条目' : '本轮未触发世界书条目'));
            return;
        }
        for (const section of groupWorldInfoSections(visible)) {
            this.content.append(this.#createSourceSection(section));
        }
    }

    #bindEvents() {
        this.toggleButton.addEventListener('click', () => this.setOpen(!this.opened));
        this.resizeHandle.addEventListener('pointerdown', event => this.#startResize(event));
        this.refreshButton.addEventListener('click', () => void this.#refresh());
        this.clearButton.addEventListener('click', () => this.store.clearLoaded());
        this.search.addEventListener('input', () => this.render());
    }

    async #refresh() {
        try {
            await this.refresh();
        } catch (error) {
            globalThis.toastr?.error?.(`世界书扫描失败：${error.message}`);
        }
    }

    #createSourceSection(section) {
        const root = element('section', { className: 'world-info-control-source' });
        const count = section.groups.reduce((total, group) => total + group.entries.length, 0);
        root.append(element('header', {
            className: 'world-info-control-source-header',
            text: `${section.label} · ${count} 个条目`,
        }));
        for (const group of section.groups) root.append(this.#createWorldGroup(group));
        return root;
    }

    #createWorldGroup(group) {
        const details = element('details', { className: 'world-info-control-group' });
        const groupKey = `${group.sourceType}:${group.name}`;
        details.open = this.groupStates.get(groupKey) ?? false;
        details.addEventListener('toggle', () => this.groupStates.set(groupKey, details.open));
        const summary = document.createElement('summary');
        summary.append(
            element('strong', { text: group.name }),
            element('small', { text: `${group.entries.length} 个条目` }),
        );
        const list = element('div', { className: 'world-info-control-list' });
        for (const entry of group.entries) list.append(this.#createEntry(entry));
        details.append(summary, list);
        return details;
    }

    #createEntry(entry) {
        const controlId = worldControlId(entry);
        const details = element('details', { className: 'world-info-control-entry' });
        details.dataset.worldInfoControlId = controlId;
        details.classList.toggle('world-info-control-excluded', this.store.isExcluded(controlId));
        const summary = document.createElement('summary');
        const copy = element('span', { className: 'world-info-control-entry-copy' });
        copy.append(
            element('strong', { text: entry.comment || `条目 ${entry.uid}` }),
            element('span', { text: summarize(entry.processedContent) }),
        );
        const metadata = element('span', { className: 'world-info-control-entry-metadata' });
        metadata.append(
            element('small', {
                text: tokenCountText(entry.tokenCount),
                attrs: { 'data-world-info-control-token': '' },
            }),
        );
        const toggle = createToggle(!this.store.isExcluded(controlId));
        toggle.addEventListener('click', event => event.stopPropagation());
        toggle.querySelector('input').addEventListener('change', event => {
            this.store.setExcluded(controlId, !event.currentTarget.checked);
        });
        summary.append(copy, metadata, toggle);
        details.append(
            summary,
            element('div', {
                className: 'world-info-control-entry-content',
                text: entry.processedContent,
            }),
        );
        return details;
    }

    #syncExclusionState() {
        const excluded = this.store.getRelevantExclusions();
        this.#updateSummary(this.store.getEntries().length, excluded.size, this.store.getStatus());
        for (const entry of this.content.querySelectorAll('[data-world-info-control-id]')) {
            const isExcluded = this.store.isExcluded(entry.dataset.worldInfoControlId);
            entry.classList.toggle('world-info-control-excluded', isExcluded);
            const input = entry.querySelector('.world-info-control-switch input');
            if (input instanceof HTMLInputElement) input.checked = !isExcluded;
        }
    }

    #syncTokenCounts() {
        const entries = new Map(this.store.getEntries().map(entry => [entry.controlId, entry]));
        for (const entry of this.content.querySelectorAll('[data-world-info-control-id]')) {
            const token = entry.querySelector('[data-world-info-control-token]');
            const current = entries.get(entry.dataset.worldInfoControlId);
            if (token && current) token.textContent = tokenCountText(current.tokenCount);
        }
    }

    #updateSummary(entryCount, excludedCount, status) {
        this.summary.textContent = status === 'ready' || status === 'scanning'
            ? `${entryCount} 个条目 · 已关闭 ${excludedCount} 个${status === 'scanning' ? ' · 扫描中' : ''}`
            : '';
        this.clearButton.disabled = status === 'loading'
            || status === 'scanning'
            || excludedCount === 0;
    }

    #restoreHeight() {
        const stored = Number(localStorage.getItem(PANEL_HEIGHT_KEY));
        if (Number.isFinite(stored) && stored > 0) {
            this.body.style.height = `${clampPanelHeight(stored)}px`;
        }
    }

    // 面板向上展开，因此指针上移时应增加内容高度
    #startResize(event) {
        if (!this.opened || event.button !== 0) return;
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = this.body.getBoundingClientRect().height;
        const move = pointerEvent => {
            const height = clampPanelHeight(startHeight + startY - pointerEvent.clientY);
            this.body.style.height = `${height}px`;
        };
        const stop = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', stop);
            window.removeEventListener('pointercancel', stop);
            localStorage.setItem(PANEL_HEIGHT_KEY, String(Math.round(this.body.getBoundingClientRect().height)));
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop, { once: true });
        window.addEventListener('pointercancel', stop, { once: true });
    }
}

/**
 * 将面板高度限制在当前视口的可用范围内
 * @param {number} height 目标高度
 * @param {number} viewportHeight 视口高度
 * @returns {number} 可用高度
 */
export function clampPanelHeight(height, viewportHeight = window.innerHeight) {
    const maximum = Math.max(MIN_PANEL_HEIGHT, Math.min(720, viewportHeight - 100));
    return Math.min(maximum, Math.max(MIN_PANEL_HEIGHT, Math.round(height)));
}

function matchesEntry(entry, query) {
    if (!query) return true;
    return [entry.world, entry.comment, entry.processedContent]
        .some(value => String(value ?? '').toLocaleLowerCase().includes(query));
}

function tokenCountText(tokenCount) {
    return Number.isFinite(tokenCount) ? `${tokenCount} Tokens` : '计算中…';
}

function summarize(content) {
    return String(content ?? '').trim().replace(/\s+/g, ' ').slice(0, 180) || '空内容';
}

function createToggle(checked) {
    const label = element('label', {
        className: 'toolbox-switch world-info-control-switch',
        title: '是否发送此世界书条目',
    });
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', '是否发送此世界书条目');
    input.checked = checked;
    label.append(input, element('span', { className: 'toolbox-switch-track' }));
    return label;
}

function createState(icon, text, loading = false) {
    const state = element('div', {
        className: `world-info-control-state${loading ? ' loading' : ''}`,
        text,
        attrs: { role: 'status' },
    });
    state.prepend(element('i', { className: `fa-solid ${icon}` }));
    return state;
}

function requireElement(root, selector) {
    const value = root.querySelector(selector);
    if (!(value instanceof HTMLElement)) throw new Error(`世界书控制模板缺少 ${selector}`);
    return value;
}

function requireButton(root, selector) {
    const value = root.querySelector(selector);
    if (!(value instanceof HTMLButtonElement)) throw new Error(`世界书控制模板缺少 ${selector}`);
    return value;
}

function requireInput(root, selector) {
    const value = root.querySelector(selector);
    if (!(value instanceof HTMLInputElement)) throw new Error(`世界书控制模板缺少 ${selector}`);
    return value;
}
