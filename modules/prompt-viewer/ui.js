import { element } from '../shared/dom.js';
import { PromptSearchController } from './search.js';
import { groupAdjacentPromptNodes } from './view-model.js';

const POSITION_KEY = 'sillytavern-toolbox:prompt-viewer-position';
const PANEL_SIZE_KEY = 'sillytavern-toolbox:prompt-viewer-size-v2';
const FLOATING_MARGIN = 8;
const MIN_PANEL_WIDTH = 320;
const MIN_PANEL_HEIGHT = 220;

/**
 * 管理提示词只读面板
 */
export class PromptViewerUi {
    /**
     * @param {object} options 配置项
     * @param {string} options.template 静态面板模板
     * @param {import('./store.js').PromptViewerStore} options.store 查看器状态
     * @param {()=>Promise<void>} options.refresh 主动提示词获取器
     */
    constructor({ template, store, refresh }) {
        this.template = template;
        this.store = store;
        this.refresh = refresh;
        this.enabled = false;
        this.floating = null;
        this.opened = false;
        this.groupStates = new Map();
    }

    initialize() {
        const holder = document.createElement('template');
        holder.innerHTML = this.template.trim();
        this.root = requireElement(holder.content, '#prompt_viewer_host');
        this.trigger = requireButton(this.root, '[data-prompt-viewer-trigger]');
        this.panel = requireElement(this.root, '[data-prompt-viewer-panel]');
        this.content = requireElement(this.root, '[data-prompt-viewer-content]');
        this.summary = requireElement(this.root, '[data-prompt-viewer-summary]');
        this.triggerTokens = requireElement(this.trigger, '[data-prompt-viewer-tokens]');
        this.refreshButton = requireButton(this.root, '[data-prompt-viewer-refresh]');
        this.refreshIcon = requireElement(this.refreshButton, 'i');
        this.search = new PromptSearchController({
            input: requireInput(this.root, '[data-prompt-viewer-search]'),
            count: requireElement(this.root, '[data-prompt-viewer-search-count]'),
            previous: requireButton(this.root, '[data-prompt-viewer-search-previous]'),
            next: requireButton(this.root, '[data-prompt-viewer-search-next]'),
            content: this.content,
            onQueryChange: () => this.render(),
        });
        document.body.append(this.root);
        this.#restorePosition();
        this.#restoreSize();
        this.#bindEvents();
        this.unsubscribe = this.store.subscribe(() => this.render());
        this.render();
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        this.root.classList.toggle('displayNone', !enabled);
        this.trigger.classList.toggle('displayNone', !enabled);
        if (!enabled) this.setOpen(false);
        else requestAnimationFrame(() => this.#keepVisible());
    }

    setFloatingMode(floating) {
        if (this.floating === floating && this.root.isConnected) return;
        const tools = document.querySelector('#leftSendForm');
        const form = document.querySelector('#send_form');
        if (!floating && (!(tools instanceof HTMLElement) || !(form instanceof HTMLElement))) return;
        this.floating = floating;
        this.root.classList.toggle('prompt-control-floating', floating);
        this.root.classList.toggle('prompt-control-input', !floating);
        this.trigger.classList.toggle('prompt-control-input-trigger', !floating);
        if (floating) {
            this.root.prepend(this.trigger);
            document.body.append(this.root);
            this.panel.style.removeProperty('min-height');
            this.#restorePosition();
            this.#restoreSize();
            requestAnimationFrame(() => this.#positionPanel());
            return;
        }
        document.body.append(this.root);
        tools.append(this.trigger);
        this.root.style.removeProperty('left');
        this.root.style.removeProperty('top');
        for (const property of ['left', 'top', 'width']) {
            this.panel.style.removeProperty(property);
        }
        requestAnimationFrame(() => this.#positionPanel());
    }

    setOpen(opened) {
        this.opened = Boolean(opened && this.enabled);
        this.panel.hidden = !this.opened;
        this.trigger.setAttribute('aria-expanded', String(this.opened));
        if (this.opened) {
            requestAnimationFrame(() => this.#positionPanel());
            if (this.store.getStatus() === 'idle') void this.#refresh();
        }
    }

    render() {
        const status = this.store.getStatus();
        const snapshot = this.store.getSnapshot();
        this.refreshButton.disabled = status === 'loading';
        this.refreshIcon.classList.toggle('fa-spin', status === 'loading');
        this.content.replaceChildren();
        if (status === 'loading') {
            this.summary.textContent = '正在获取';
            this.triggerTokens.textContent = '';
            this.content.append(createState('fa-circle-notch fa-spin', '正在获取当前提示词…'));
            this.search.sync();
            return;
        }
        if (status === 'error') {
            this.summary.textContent = '获取失败';
            this.triggerTokens.textContent = '';
            this.content.append(createState('fa-triangle-exclamation', this.store.getError()));
            this.search.sync();
            return;
        }
        if (!snapshot) {
            this.summary.textContent = '';
            this.triggerTokens.textContent = '';
            this.content.append(createState('fa-rotate-right', '点击刷新获取当前提示词'));
            this.search.sync();
            return;
        }
        const messageCount = snapshot.finalNodes.length;
        this.summary.textContent = `${formatNumber(snapshot.totalTokens)} Tokens · ${messageCount} 条消息`;
        this.triggerTokens.textContent = String(snapshot.totalTokens);
        for (const group of groupAdjacentPromptNodes(snapshot.finalNodes)) {
            this.content.append(this.#createRoleGroup(group));
        }
        this.search.sync();
    }

    #createRoleGroup(group) {
        const details = element('details', { className: 'prompt-control-role-group' });
        details.open = this.groupStates.get(group.id) ?? false;
        details.addEventListener('toggle', () => this.groupStates.set(group.id, details.open));
        const heading = document.createElement('summary');
        heading.className = 'prompt-control-group-heading';
        const copy = element('span', { className: 'prompt-control-group-copy' });
        const title = element('span', { className: 'prompt-control-group-title' });
        const tokenText = `${formatNumber(group.tokenCount)} Tokens`;
        title.append(
            element('strong', { text: `Role: ${roleIcon(group.role)} ${group.role}` }),
            element('small', {
                text: group.nodes.length > 1
                    ? `${group.nodes.length} 条 · ${tokenText}`
                    : tokenText,
            }),
        );
        copy.append(
            title,
            element('span', {
                className: 'prompt-control-group-summary',
                text: summarize(group.nodes.map(node => node.content).join(' ')),
            }),
        );
        heading.append(copy);
        const messages = element('div', { className: 'prompt-control-role-messages' });
        if (group.nodes.length === 1) {
            const body = element('div', {
                className: 'prompt-control-message-body prompt-control-single-message-body',
            });
            this.search.appendHighlighted(body, group.nodes[0].content);
            messages.append(body);
        } else {
            group.nodes.forEach(node => messages.append(this.#createMessage(node)));
        }
        details.append(heading, messages);
        return details;
    }

    #createMessage(node) {
        const details = element('details', { className: 'prompt-control-message' });
        const summary = document.createElement('summary');
        const label = element('span', { className: 'prompt-control-message-label' });
        label.append(
            element('strong', { text: `#${node.sendIndex + 1} 消息` }),
            element('span', {
                className: 'prompt-control-message-preview',
                text: summarize(node.content),
            }),
        );
        summary.append(
            label,
            element('small', { text: `${formatNumber(node.tokenCount)} Tokens` }),
        );
        const body = element('div', { className: 'prompt-control-message-body' });
        this.search.appendHighlighted(body, node.content);
        details.append(summary, body);
        return details;
    }

    #bindEvents() {
        this.trigger.addEventListener('click', () => {
            if (this.dragState?.moved) return;
            this.setOpen(!this.opened);
        });
        this.trigger.addEventListener('pointerdown', event => this.#startDrag(event));
        this.trigger.addEventListener('pointermove', event => this.#moveDrag(event));
        this.trigger.addEventListener('pointerup', event => this.#finishDrag(event));
        requireButton(this.root, '[data-prompt-viewer-collapse]')
            .addEventListener('click', () => this.setOpen(false));
        this.refreshButton.addEventListener('click', () => void this.#refresh());
        this.search.bind();
        for (const handle of this.root.querySelectorAll('[data-prompt-resize]')) {
            handle.addEventListener('pointerdown', event => this.#startResize(event, handle.dataset.promptResize));
            handle.addEventListener('pointermove', event => this.#moveResize(event));
            handle.addEventListener('pointerup', event => this.#finishResize(event));
        }
        window.addEventListener('resize', () => {
            this.#keepVisible();
            this.#positionPanel();
        });
    }

    async #refresh() {
        try {
            await this.refresh();
        } catch (error) {
            globalThis.toastr?.error?.(error instanceof Error ? error.message : String(error), '提示词查看');
        }
    }

    #startDrag(event) {
        if (!this.floating || event.button !== 0) return;
        const rect = this.root.getBoundingClientRect();
        this.dragState = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            left: rect.left,
            top: rect.top,
            moved: false,
        };
        this.trigger.setPointerCapture(event.pointerId);
    }

    #moveDrag(event) {
        const state = this.dragState;
        if (!state || state.pointerId !== event.pointerId) return;
        const delta = { x: event.clientX - state.startX, y: event.clientY - state.startY };
        if (!state.moved && Math.hypot(delta.x, delta.y) < 4) return;
        state.moved = true;
        const position = clampFloatingPosition(
            { x: state.left + delta.x, y: state.top + delta.y },
            { width: this.root.offsetWidth, height: this.root.offsetHeight },
            { width: window.innerWidth, height: window.innerHeight },
        );
        this.root.style.left = `${position.x}px`;
        this.root.style.top = `${position.y}px`;
        this.#positionPanel();
    }

    #finishDrag(event) {
        if (!this.dragState || this.dragState.pointerId !== event.pointerId) return;
        const moved = this.dragState.moved;
        this.dragState = moved ? { moved: true } : null;
        if (moved) {
            this.#savePosition();
            setTimeout(() => {
                this.dragState = null;
            });
        }
    }

    #startResize(event, direction) {
        if (event.button !== 0 || (!this.floating && direction !== 'n')) return;
        const rect = this.panel.getBoundingClientRect();
        this.resizeState = {
            pointerId: event.pointerId,
            direction,
            startX: event.clientX,
            startY: event.clientY,
            bounds: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            input: !this.floating,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    }

    #moveResize(event) {
        const state = this.resizeState;
        if (!state || state.pointerId !== event.pointerId) return;
        if (state.input) {
            const form = document.querySelector('#send_form');
            if (!(form instanceof HTMLElement)) return;
            const available = Math.max(120, form.getBoundingClientRect().top - 14);
            const height = clamp(
                state.bounds.height - (event.clientY - state.startY),
                Math.min(MIN_PANEL_HEIGHT, available),
                available,
            );
            this.panel.style.height = `${height}px`;
            this.#positionPanel();
            return;
        }
        const bounds = resizeFloatingPanel(
            state.bounds,
            state.direction,
            { x: event.clientX - state.startX, y: event.clientY - state.startY },
            { width: window.innerWidth, height: window.innerHeight },
        );
        Object.assign(this.panel.style, {
            left: `${bounds.left}px`,
            top: `${bounds.top}px`,
            width: `${bounds.width}px`,
            height: `${bounds.height}px`,
        });
    }

    #finishResize(event) {
        if (!this.resizeState || this.resizeState.pointerId !== event.pointerId) return;
        this.resizeState = null;
        const rect = this.panel.getBoundingClientRect();
        localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify({ width: rect.width, height: rect.height }));
        this.#positionPanel();
    }

    #restorePosition() {
        let position = { x: 8, y: window.innerHeight - 58 };
        try {
            position = JSON.parse(localStorage.getItem(POSITION_KEY)) ?? position;
        } catch {
            localStorage.removeItem(POSITION_KEY);
        }
        const safe = clampFloatingPosition(
            position,
            { width: 42, height: 42 },
            { width: window.innerWidth, height: window.innerHeight },
        );
        this.root.style.left = `${safe.x}px`;
        this.root.style.top = `${safe.y}px`;
    }

    #savePosition() {
        const rect = this.root.getBoundingClientRect();
        localStorage.setItem(POSITION_KEY, JSON.stringify({ x: rect.left, y: rect.top }));
    }

    #restoreSize() {
        try {
            const size = JSON.parse(localStorage.getItem(PANEL_SIZE_KEY));
            if (Number.isFinite(size?.width)) this.panel.style.width = `${size.width}px`;
            if (Number.isFinite(size?.height)) this.panel.style.height = `${size.height}px`;
        } catch {
            localStorage.removeItem(PANEL_SIZE_KEY);
        }
    }

    #keepVisible() {
        if (!this.floating) return;
        const rect = this.root.getBoundingClientRect();
        const position = clampFloatingPosition(
            { x: rect.left, y: rect.top },
            { width: rect.width || 42, height: rect.height || 42 },
            { width: window.innerWidth, height: window.innerHeight },
        );
        this.root.style.left = `${position.x}px`;
        this.root.style.top = `${position.y}px`;
    }

    #positionPanel() {
        if (!this.opened) return;
        if (this.floating) {
            const position = placeFloatingPanel(
                this.root.getBoundingClientRect(),
                this.panel.getBoundingClientRect(),
                { width: window.innerWidth, height: window.innerHeight },
            );
            this.panel.style.left = `${position.left}px`;
            this.panel.style.top = `${position.top}px`;
            return;
        }
        const form = document.querySelector('#send_form');
        if (!(form instanceof HTMLElement)) return;
        const formRect = form.getBoundingClientRect();
        const width = Math.min(formRect.width, window.innerWidth - 16);
        const availableHeight = Math.max(120, formRect.top - 14);
        const requestedHeight = this.panel.getBoundingClientRect().height || 520;
        const height = clamp(
            requestedHeight,
            Math.min(MIN_PANEL_HEIGHT, availableHeight),
            availableHeight,
        );
        this.panel.style.minHeight = `${Math.min(MIN_PANEL_HEIGHT, availableHeight)}px`;
        this.panel.style.left = `${clamp(formRect.left, 8, window.innerWidth - width - 8)}px`;
        this.panel.style.top = `${formRect.top - height - 6}px`;
        this.panel.style.width = `${width}px`;
        this.panel.style.height = `${height}px`;
    }
}

export function clampFloatingPosition(position, size, viewport) {
    return {
        x: clamp(position.x, FLOATING_MARGIN, viewport.width - size.width - FLOATING_MARGIN),
        y: clamp(position.y, FLOATING_MARGIN, viewport.height - size.height - FLOATING_MARGIN),
    };
}

export function resizeFloatingPanel(bounds, direction, delta, viewport) {
    let left = bounds.left;
    let top = bounds.top;
    let right = bounds.left + bounds.width;
    let bottom = bounds.top + bounds.height;
    if (direction.includes('w')) left = clamp(left + delta.x, 8, right - MIN_PANEL_WIDTH);
    if (direction.includes('e')) right = clamp(right + delta.x, left + MIN_PANEL_WIDTH, viewport.width - 8);
    if (direction.includes('n')) top = clamp(top + delta.y, 8, bottom - MIN_PANEL_HEIGHT);
    if (direction.includes('s')) bottom = clamp(bottom + delta.y, top + MIN_PANEL_HEIGHT, viewport.height - 8);
    return { left, top, width: right - left, height: bottom - top };
}

export function placeFloatingPanel(bubble, panel, viewport) {
    const left = clamp(
        bubble.left + bubble.width / 2 - panel.width / 2,
        8,
        viewport.width - panel.width - 8,
    );
    const below = bubble.bottom + 8;
    const above = bubble.top - panel.height - 8;
    const top = below + panel.height <= viewport.height - 8
        ? below
        : clamp(above, 8, viewport.height - panel.height - 8);
    return { left, top };
}

function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function requireElement(root, selector) {
    const value = root.querySelector(selector);
    if (!(value instanceof HTMLElement)) throw new Error(`提示词查看器模板缺少 ${selector}`);
    return value;
}

function requireButton(root, selector) {
    const value = root.querySelector(selector);
    if (!(value instanceof HTMLButtonElement)) throw new Error(`提示词查看器模板缺少 ${selector}`);
    return value;
}

function requireInput(root, selector) {
    const value = root.querySelector(selector);
    if (!(value instanceof HTMLInputElement)) throw new Error(`提示词查看器模板缺少 ${selector}`);
    return value;
}

function createState(icon, text) {
    const root = element('div', { className: 'prompt-control-state' });
    root.append(
        element('i', { className: `fa-solid ${icon}` }),
        element('span', { text }),
    );
    return root;
}

function formatNumber(value) {
    return new Intl.NumberFormat().format(Number(value) || 0);
}

function summarize(content) {
    return String(content ?? '').trim().replace(/\s+/g, ' ').slice(0, 240) || '空内容';
}

function roleIcon(role) {
    return {
        system: '⚙️',
        user: '👤',
        assistant: '🤖',
        tool: '🔧',
        prompt: '📝',
    }[role] ?? '•';
}
