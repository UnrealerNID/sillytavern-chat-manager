import { element } from '../shared/dom.js';
import { groupContributionsBySource } from './snapshot.js';

const VIEW_LABELS = Object.freeze({
    prompt: '本轮提示词',
    position: '发送位置',
    source: '来源类型',
});
const RENDER_BATCH_SIZE = 100;

/**
 * 管理输入框附近的提示词折叠面板
 */
export class PromptControlUi {
    /**
     * @param {object} options 配置项
     * @param {string} options.template 静态面板模板
     * @param {import('./snapshot.js').PromptSnapshotStore} options.store 快照状态
     * @param {()=>Promise<void>} options.refresh 刷新回调
     */
    constructor({ template, store, refresh }) {
        this.template = template;
        this.store = store;
        this.refresh = refresh;
        this.enabled = false;
        this.opened = false;
        this.view = 'prompt';
        this.refreshTimer = null;
        this.unsubscribe = null;
    }

    /**
     * 插入静态面板和输入框按钮
     */
    initialize() {
        if (this.root) return;
        const holder = document.createElement('template');
        holder.innerHTML = this.template.trim();
        const root = holder.content.firstElementChild;
        if (!(root instanceof HTMLElement)) throw new Error('本轮提示词模板结构无效');
        const trigger = root.querySelector('[data-prompt-control-trigger]');
        const panel = root.querySelector('[data-prompt-control-panel]');
        const form = document.querySelector('#send_form');
        if (!(trigger instanceof HTMLButtonElement) || !(panel instanceof HTMLElement)) {
            throw new Error('本轮提示词模板缺少入口或面板');
        }
        if (!(form instanceof HTMLElement)) {
            throw new Error('酒馆输入框尚未就绪');
        }
        // 入口与面板悬浮在输入区上边缘，不参与酒馆输入区布局
        form.classList.add('prompt-control-anchor');
        form.append(root);
        this.root = root;
        this.trigger = trigger;
        this.panel = panel;
        this.content = requireElement(root, '[data-prompt-control-content]');
        this.status = requireElement(root, '[data-prompt-control-status]');
        this.summary = requireElement(root, '[data-prompt-control-summary]');
        this.triggerTokens = requireElement(trigger, '[data-prompt-control-trigger-tokens]');
        this.#bindEvents();
        this.unsubscribe = this.store.subscribe(() => this.render());
        this.render();
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        this.root?.classList.toggle('displayNone', !enabled);
        this.trigger?.classList.toggle('displayNone', !enabled);
        if (!enabled) this.setOpen(false);
    }

    /**
     * 标记输入变化并在面板展开时安排刷新
     */
    scheduleRefresh() {
        if (!this.enabled) return;
        this.store.setStatus('stale');
        if (!this.opened) return;
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => void this.#refresh(), 500);
    }

    /**
     * 切换面板展开状态
     * @param {boolean} opened 是否展开
     */
    setOpen(opened) {
        this.opened = Boolean(opened && this.enabled);
        if (this.panel) this.panel.hidden = !this.opened;
        if (this.trigger) this.trigger.setAttribute('aria-expanded', String(this.opened));
        if (this.opened && this.store.getStatus() !== 'ready') void this.#refresh();
    }

    /**
     * 渲染当前视图
     */
    render() {
        if (!this.content) return;
        const snapshot = this.store.getSnapshot();
        this.#renderStatus(snapshot);
        this.renderInto(this.content, this.view);
    }

    /**
     * 将指定结构视图渲染到外部容器
     * @param {HTMLElement} container 目标容器
     * @param {'position'|'source'|'prompt'} view 视图类型
     */
    renderInto(container, view) {
        const snapshot = this.store.getSnapshot();
        container.replaceChildren();
        if (!snapshot) {
            container.append(element('div', {
                className: 'prompt-control-empty',
                text: '刷新以读取本轮提示词',
            }));
            return;
        }
        if (view === 'prompt') this.#renderPrompt(container, snapshot);
        if (view === 'position') this.#renderPositions(container, snapshot);
        if (view === 'source') this.#renderSources(container, snapshot);
    }

    #bindEvents() {
        this.trigger.addEventListener('click', () => this.setOpen(!this.opened));
        requireButton(this.root, '[data-prompt-control-collapse]')
            .addEventListener('click', () => this.setOpen(false));
        requireButton(this.root, '[data-prompt-control-refresh]')
            .addEventListener('click', () => void this.#refresh());
        requireButton(this.root, '[data-prompt-control-clear]')
            .addEventListener('click', () => {
                this.store.clearCurrent();
                void this.#refresh();
            });
        for (const tab of this.root.querySelectorAll('[data-prompt-view]')) {
            tab.addEventListener('click', () => {
                this.view = tab.dataset.promptView;
                for (const button of this.root.querySelectorAll('[data-prompt-view]')) {
                    button.classList.toggle('selected', button === tab);
                }
                this.render();
            });
        }
    }

    async #refresh() {
        if (!this.enabled || this.store.getStatus() === 'loading') return;
        try {
            await this.refresh();
        } catch (error) {
            globalThis.toastr?.error?.(`读取本轮提示词失败：${error.message}`);
        }
    }

    #renderStatus(snapshot) {
        const status = this.store.getStatus();
        const statusText = {
            idle: '选择角色或群聊后可读取',
            stale: '内容已变化，等待刷新',
            loading: '正在装配本轮提示词…',
            ready: snapshot?.kind === 'actual' ? '已捕获实际发送' : '当前预览',
            error: '读取失败，不影响正常发送',
        }[status] ?? '';
        this.status.textContent = statusText;
        const total = enabledTokenTotal(snapshot, this.store);
        this.summary.textContent = snapshot
            ? `${VIEW_LABELS[this.view]} · Tokens: ${total}`
            : '尚未读取';
        this.triggerTokens.textContent = snapshot ? String(total) : '';
        this.trigger.title = snapshot ? `查看本轮提示词 · ${total} Token` : '查看本轮提示词';
    }

    #renderPrompt(container, snapshot) {
        appendInBatches(
            container,
            snapshot.finalNodes,
            node => this.#createFinalNode(node, false, snapshot),
        );
    }

    #renderPositions(container, snapshot) {
        appendInBatches(
            container,
            snapshot.finalNodes,
            node => this.#createFinalNode(node, true, snapshot),
        );
    }

    #renderSources(container, snapshot) {
        for (const group of groupContributionsBySource(snapshot.contributions)) {
            const section = element('section', { className: 'prompt-control-source-group' });
            const heading = element('header', { className: 'prompt-control-group-heading' });
            heading.append(
                element('strong', { text: group.label }),
                element('small', { text: `${group.items.length} 项` }),
            );
            section.append(heading);
            appendInBatches(section, group.items, item => this.#createContribution(item));
            container.append(section);
        }
    }

    #createFinalNode(node, includeContributions, snapshot) {
        const card = element('article', { className: 'prompt-control-card' });
        const header = element('header', { className: 'prompt-control-card-header' });
        header.append(
            element('span', {
                className: 'prompt-control-item-meta',
                text: `Role: ${roleIcon(node.role)} ${node.role} | Tokens: ${node.tokenCount}`,
            }),
            this.#createToggle(node.id, node.controlLevel),
        );
        card.append(header, createContent(node.content));
        if (includeContributions) {
            const items = snapshot.contributions.filter(item => item.finalNodeId === node.id);
            const details = element('div', { className: 'prompt-control-contributions' });
            if (!items.length) {
                details.append(element('small', { text: '该消息没有可识别的来源边界' }));
            } else {
                for (const item of items) details.append(this.#createContribution(item));
            }
            card.append(details);
        }
        card.classList.toggle('prompt-control-excluded', this.store.isExcluded(node.id));
        return card;
    }

    #createContribution(item) {
        const row = element('article', { className: 'prompt-control-contribution' });
        const copy = element('div', { className: 'prompt-control-contribution-copy' });
        copy.append(
            element('strong', { text: item.sourceName }),
            element('small', { text: `Tokens: ${item.tokenCount}` }),
        );
        if (item.content) copy.append(createContent(item.content));
        row.append(copy, this.#createToggle(item.controlId, item.controlLevel));
        row.classList.toggle(
            'prompt-control-excluded',
            Boolean(item.controlId && this.store.isExcluded(item.controlId)),
        );
        return row;
    }

    #createToggle(controlId, level) {
        const label = element('label', {
            className: 'prompt-control-switch',
            title: level === 'locked' ? '该内容没有可安全修改的独立边界' : '是否发送此内容',
        });
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !this.store.isExcluded(controlId);
        input.disabled = level === 'locked' || !controlId;
        input.addEventListener('change', () => {
            this.store.setExcluded(controlId, !input.checked);
            if (level === 'source') void this.#refresh();
        });
        label.append(input, element('span'));
        return label;
    }
}

function createContent(content) {
    const details = element('details', { className: 'prompt-control-text' });
    details.append(element('summary', {
        text: content.trim().split(/\r?\n/)[0].slice(0, 160) || '空内容',
    }));
    details.addEventListener('toggle', () => {
        if (details.open && details.childElementCount === 1) {
            details.append(element('pre', { text: content }));
        }
    });
    return details;
}

function appendInBatches(container, items, renderItem) {
    let rendered = 0;
    const appendNext = () => {
        const fragment = document.createDocumentFragment();
        const end = Math.min(rendered + RENDER_BATCH_SIZE, items.length);
        while (rendered < end) fragment.append(renderItem(items[rendered++]));
        loadMore.remove();
        container.append(fragment);
        if (rendered < items.length) {
            loadMore.textContent = `继续显示（${rendered} / ${items.length}）`;
            container.append(loadMore);
        }
    };
    const loadMore = element('button', {
        className: 'menu_button prompt-control-load-more',
        text: '继续显示',
        type: 'button',
    });
    loadMore.addEventListener('click', appendNext);
    appendNext();
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

function enabledTokenTotal(snapshot, store) {
    if (!snapshot) return 0;
    return snapshot.finalNodes
        .filter(node => !store.isExcluded(node.id))
        .reduce((total, node) => total + node.tokenCount, 0);
}

function requireElement(root, selector) {
    const value = root.querySelector(selector);
    if (!(value instanceof HTMLElement)) throw new Error(`本轮提示词模板缺少 ${selector}`);
    return value;
}

function requireButton(root, selector) {
    const value = root.querySelector(selector);
    if (!(value instanceof HTMLButtonElement)) throw new Error(`本轮提示词模板缺少 ${selector}`);
    return value;
}
