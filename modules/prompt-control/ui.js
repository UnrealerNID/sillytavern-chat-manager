import { element } from '../shared/dom.js';
import { PromptSearchController } from './search.js';
import {
    createPromptDisplayNodes,
    createSourceTree,
    groupAdjacentPromptNodes,
} from './view-model.js';

const RENDER_BATCH_SIZE = 100;
const POSITION_KEY = 'sillytavern-toolbox:prompt-control-position';
const PANEL_SIZE_KEY = 'sillytavern-toolbox:prompt-control-panel-size';
const INPUT_PANEL_HEIGHT_KEY = 'sillytavern-toolbox:prompt-control-input-height';
const FLOATING_MARGIN = 8;
const DEFAULT_BUBBLE_SIZE = 42;
const MIN_PANEL_WIDTH = 320;
const MIN_PANEL_HEIGHT = 220;

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
        this.floating = true;
        this.opened = false;
        this.view = 'prompt';
        this.refreshTimer = null;
        this.unsubscribe = null;
        this.dragState = null;
        this.resizeState = null;
        this.preferredPanelSize = null;
        this.ignoreNextClick = false;
        this.viewportController = null;
        this.groupStates = new Map();
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
        if (!(trigger instanceof HTMLButtonElement) || !(panel instanceof HTMLElement)) {
            throw new Error('本轮提示词模板缺少入口或面板');
        }
        document.body.append(root);
        this.root = root;
        this.trigger = trigger;
        this.panel = panel;
        this.content = requireElement(root, '[data-prompt-control-content]');
        this.status = requireElement(root, '[data-prompt-control-status]');
        this.summary = requireElement(root, '[data-prompt-control-summary]');
        this.clearButton = requireButton(root, '[data-prompt-control-clear]');
        this.search = new PromptSearchController({
            input: requireInput(root, '[data-prompt-control-search]'),
            count: requireElement(root, '[data-prompt-control-search-count]'),
            previous: requireButton(root, '[data-prompt-control-search-previous]'),
            next: requireButton(root, '[data-prompt-control-search-next]'),
            content: this.content,
            onQueryChange: () => this.render(),
        });
        this.triggerTokens = requireElement(trigger, '[data-prompt-control-trigger-tokens]');
        this.root.classList.add('prompt-control-floating');
        this.#restorePosition();
        this.#restorePanelSize();
        this.#bindEvents();
        this.unsubscribe = this.store.subscribe(() => this.render());
        this.render();
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        this.root?.classList.toggle('displayNone', !enabled);
        this.trigger?.classList.toggle('displayNone', !enabled);
        if (!enabled) this.setOpen(false);
        else requestAnimationFrame(() => this.#keepBubbleVisible());
    }

    /**
     * 在全局悬浮气泡与输入区入口之间切换
     * @param {boolean} floating 是否使用悬浮气泡
     */
    setFloatingMode(floating) {
        if (!this.root || this.floating === floating && this.root.isConnected) return;
        const inputTools = document.querySelector('#leftSendForm');
        const form = document.querySelector('#send_form');
        if (!floating && (!(inputTools instanceof HTMLElement) || !(form instanceof HTMLElement))) return;
        this.floating = floating;
        this.root.classList.toggle('prompt-control-floating', floating);
        this.root.classList.toggle('prompt-control-input', !floating);
        this.trigger.classList.toggle('prompt-control-input-trigger', !floating);
        if (floating) {
            this.root.prepend(this.trigger);
            document.body.append(this.root);
            this.#restorePosition();
            this.#restorePanelSize();
            requestAnimationFrame(() => {
                this.#keepBubbleVisible();
                this.#positionPanel();
            });
            return;
        }
        form.classList.add('prompt-control-anchor');
        form.append(this.root);
        inputTools.append(this.trigger);
        this.root.style.removeProperty('left');
        this.root.style.removeProperty('top');
        for (const property of ['left', 'top', 'width', 'height']) {
            this.panel.style.removeProperty(property);
        }
        this.#restoreInputPanelHeight();
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
        if (this.opened) {
            requestAnimationFrame(() => {
                this.#fitPanelToViewport();
                this.#positionPanel();
            });
            if (this.store.getStatus() !== 'ready') void this.#refresh();
        }
    }

    /**
     * 渲染当前视图
     */
    render() {
        if (!this.content) return;
        const snapshot = this.store.getSnapshot();
        this.#renderStatus(snapshot);
        this.renderInto(this.content, this.view);
        this.search.sync();
    }

    /**
     * 将指定结构视图渲染到外部容器
     * @param {HTMLElement} container 目标容器
     * @param {'source'|'prompt'} view 视图类型
     */
    renderInto(container, view) {
        const snapshot = this.store.getSnapshot();
        container.replaceChildren();
        if (this.store.getStatus() === 'loading') {
            container.append(createLoadingState());
            return;
        }
        if (!snapshot) {
            container.append(element('div', {
                className: 'prompt-control-empty',
                text: '刷新以读取本轮提示词',
            }));
            return;
        }
        if (view === 'prompt') this.#renderPrompt(container, snapshot);
        if (view === 'source') this.#renderSources(container, snapshot);
    }

    #bindEvents() {
        this.trigger.addEventListener('click', () => {
            if (this.ignoreNextClick) {
                this.ignoreNextClick = false;
                return;
            }
            this.setOpen(!this.opened);
        });
        this.trigger.addEventListener('pointerdown', event => this.#startDrag(event));
        this.trigger.addEventListener('pointermove', event => this.#moveDrag(event));
        this.trigger.addEventListener('pointerup', event => this.#finishDrag(event));
        this.trigger.addEventListener('pointercancel', event => this.#finishDrag(event));
        this.viewportController?.abort();
        this.viewportController = new AbortController();
        window.addEventListener('resize', () => {
            this.#keepBubbleVisible();
            this.#fitPanelToViewport();
            this.#positionPanel();
        }, { signal: this.viewportController.signal });
        for (const handle of this.root.querySelectorAll('[data-prompt-resize]')) {
            handle.addEventListener('pointerdown', event => {
                this.#startPanelResize(event, handle.dataset.promptResize);
            });
            handle.addEventListener('pointermove', event => this.#movePanelResize(event));
            handle.addEventListener('pointerup', event => this.#finishPanelResize(event));
            handle.addEventListener('pointercancel', event => this.#finishPanelResize(event));
        }
        requireButton(this.root, '[data-prompt-control-collapse]')
            .addEventListener('click', () => this.setOpen(false));
        requireButton(this.root, '[data-prompt-control-refresh]')
            .addEventListener('click', () => void this.#refresh());
        this.clearButton.addEventListener('click', () => {
            this.store.clearCurrent();
            void this.#refresh();
        });
        this.search.bind();
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
            loading: '',
            ready: '',
            error: '读取失败，不影响正常发送',
        }[status] ?? '';
        this.status.textContent = statusText;
        this.status.hidden = status === 'loading' || status === 'ready';
        const hasExclusions = this.store.getExclusions().size > 0;
        this.clearButton.disabled = !hasExclusions || status === 'loading';
        const total = enabledTokenTotal(snapshot, this.store);
        this.summary.textContent = status === 'loading'
            ? '正在读取'
            : snapshot
            ? `${formatNumber(total)} Tokens · ${snapshot.finalNodes.length} 条消息`
            : '尚未读取';
        this.triggerTokens.textContent = snapshot && status !== 'loading' ? String(total) : '';
        this.trigger.title = snapshot && status !== 'loading'
            ? `查看本轮提示词 · ${total} Token`
            : '查看本轮提示词';
    }

    #renderPrompt(container, snapshot) {
        appendInBatches(
            container,
            groupAdjacentPromptNodes(createPromptDisplayNodes(snapshot)),
            group => this.#createRoleGroup(group),
        );
    }

    #createRoleGroup(group) {
        const card = element('details', { className: 'prompt-control-role-group' });
        this.#bindGroupState(card, `role:${group.id}`);
        const header = this.#createGroupHeading({
            label: `Role: ${roleIcon(group.role)} ${group.role}`,
            count: group.nodes.length,
            tokenCount: group.tokenCount,
            preview: summarizeItems(group.nodes, item => item.content),
        });
        if (group.nodes.length === 1) {
            const [node] = group.nodes;
            this.#appendToggle(header, node.id, node.controlLevel);
            card.append(header, this.#createContentBody(node.content, 'prompt-control-single-content'));
        } else {
            const toggle = this.#createGroupToggle(group.nodes);
            toggle.addEventListener('click', event => event.stopPropagation());
            header.append(toggle);
            const messages = element('div', { className: 'prompt-control-role-messages' });
            group.nodes.forEach((node, index) => {
                messages.append(this.#createPromptMessage(node, index, group.nodes.length));
            });
            card.append(header, messages);
        }
        const singleContent = group.nodes.length === 1 ? group.nodes[0].content : '';
        if (this.search.matches(group.role, singleContent)) {
            this.search.mark(card);
        }
        return card;
    }

    #createGroupToggle(nodes) {
        const controllable = nodes.filter(node => node.controlLevel !== 'locked');
        const label = element('label', {
            className: 'prompt-control-switch',
            title: controllable.length ? '是否发送该组消息' : '该组消息不可单独关闭',
        });
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.disabled = !controllable.length;
        const enabledCount = controllable.filter(node => !this.store.isExcluded(node.id)).length;
        input.checked = enabledCount > 0;
        input.indeterminate = enabledCount > 0 && enabledCount < controllable.length;
        input.addEventListener('change', () => {
            this.store.setExclusions(controllable.map(node => node.id), !input.checked);
        });
        label.append(input, element('span'));
        return label;
    }

    #createPromptMessage(node, index, groupSize) {
        const preview = summarizeContent(node.content);
        const source = node.sourceName ? `${node.sourceName} · ` : '';
        return this.#createEntry({
            label: groupSize > 1 ? `#${index + 1} ${source}${preview}` : `${source}${preview}`,
            content: node.content,
            tokenCount: node.tokenCount,
            controlId: node.id,
            controlLevel: node.controlLevel,
        });
    }

    #renderSources(container, snapshot) {
        for (const group of createSourceTree(snapshot.contributions)) {
            container.append(this.#createSourceGroup(group));
        }
    }

    #createSourceGroup(group, nested = false) {
        const section = element('details', {
            className: nested ? 'prompt-control-source-branch' : 'prompt-control-source-group',
        });
        this.#bindGroupState(section, group.id);
        const heading = this.#createGroupHeading({
            className: nested ? 'prompt-control-source-branch-heading' : '',
            label: group.label,
            count: group.allItems.length,
            tokenCount: sumTokens(group.allItems),
            preview: summarizeItems(group.allItems, item => item.content),
        });
        section.append(heading);
        for (const child of group.children) {
            section.append(this.#createSourceGroup(child, true));
        }
        appendInBatches(section, group.items, item => this.#createContribution(item));
        if (this.search.matches(group.label)) this.search.mark(section);
        return section;
    }

    /**
     * 创建两种视图共用的折叠组头
     * @param {object} options 组头数据
     * @param {string} [options.className] 附加类名
     * @param {string} options.label 标题
     * @param {number} options.count 项目数
     * @param {number} options.tokenCount Token 数
     * @param {string} options.preview 内容摘要
     * @returns {HTMLElement} 折叠组头
     */
    #createGroupHeading({ className = '', label, count, tokenCount, preview }) {
        const heading = document.createElement('summary');
        heading.className = `prompt-control-group-heading ${className}`.trim();
        const title = element('span', { className: 'prompt-control-group-title' });
        const name = element('strong');
        this.search.appendHighlighted(name, label);
        title.append(
            name,
            element('small', {
                text: `${count} 条 · ${formatNumber(tokenCount)} Tokens`,
            }),
        );
        const summary = element('span', { className: 'prompt-control-group-summary' });
        this.search.appendHighlighted(summary, preview);
        const copy = element('span', { className: 'prompt-control-group-copy' });
        copy.append(title, summary);
        heading.append(copy);
        return heading;
    }

    #createContribution(item) {
        return this.#createEntry({
            className: 'prompt-control-source-entry',
            label: `${item.sourceName} · ${summarizeContent(item.content)}`,
            content: item.content,
            tokenCount: item.tokenCount,
            controlId: item.controlId,
            controlLevel: item.controlLevel,
            searchTerms: [item.sourceName, item.content],
        });
    }

    /**
     * 创建提示词与来源视图共用的内容行
     * @param {object} options 内容行数据
     * @param {string} [options.className] 附加类名
     * @param {string} options.label 折叠摘要
     * @param {string} options.content 完整内容
     * @param {number} options.tokenCount Token 数
     * @param {string} options.controlId 控制标识
     * @param {string} options.controlLevel 控制层级
     * @param {unknown[]} [options.searchTerms] 搜索内容
     * @returns {HTMLElement} 可折叠内容行
     */
    #createEntry({
        className = '',
        label,
        content,
        tokenCount,
        controlId,
        controlLevel,
        searchTerms = [content],
    }) {
        const details = element('details', {
            className: `prompt-control-message ${className}`.trim(),
        });
        const summary = document.createElement('summary');
        const labelElement = element('span', { className: 'prompt-control-message-label' });
        this.search.appendHighlighted(labelElement, label);
        summary.append(
            labelElement,
            element('small', { text: `${formatNumber(tokenCount)} Tokens` }),
        );
        this.#appendToggle(summary, controlId, controlLevel);
        const body = this.#createContentBody(content);
        details.append(summary, body);
        details.classList.toggle(
            'prompt-control-excluded',
            Boolean(controlId && this.store.isExcluded(controlId)),
        );
        if (this.search.matches(...searchTerms)) this.search.mark(details);
        return details;
    }

    #createContentBody(content, className = '') {
        const body = element('pre', { className });
        this.search.appendHighlighted(body, content);
        return body;
    }

    #appendToggle(container, controlId, controlLevel) {
        const toggle = this.#createToggle(controlId, controlLevel);
        toggle.addEventListener('click', event => event.stopPropagation());
        container.append(toggle);
    }

    #bindGroupState(details, key) {
        details.open = this.groupStates.get(key) ?? false;
        details.addEventListener('toggle', () => this.groupStates.set(key, details.open));
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
        this.trigger.classList.add('dragging');
    }

    #moveDrag(event) {
        const state = this.dragState;
        if (!state || state.pointerId !== event.pointerId) return;
        const deltaX = event.clientX - state.startX;
        const deltaY = event.clientY - state.startY;
        if (!state.moved && Math.hypot(deltaX, deltaY) < 4) return;
        state.moved = true;
        event.preventDefault();
        this.#applyPosition(clampFloatingPosition(
            { x: state.left + deltaX, y: state.top + deltaY },
            { width: this.root.offsetWidth, height: this.root.offsetHeight },
            { width: window.innerWidth, height: window.innerHeight },
        ));
        this.#positionPanel();
    }

    #finishDrag(event) {
        const state = this.dragState;
        if (!state || state.pointerId !== event.pointerId) return;
        if (this.trigger.hasPointerCapture(event.pointerId)) {
            this.trigger.releasePointerCapture(event.pointerId);
        }
        this.trigger.classList.remove('dragging');
        this.dragState = null;
        if (!state.moved) return;
        this.ignoreNextClick = true;
        this.#savePosition();
    }

    #startPanelResize(event, direction) {
        if (event.button !== 0 || !direction || !this.floating && direction !== 'n') return;
        event.preventDefault();
        event.stopPropagation();
        const rect = this.panel.getBoundingClientRect();
        this.resizeState = {
            pointerId: event.pointerId,
            direction,
            startX: event.clientX,
            startY: event.clientY,
            bounds: {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
            },
            handle: event.currentTarget,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    }

    #movePanelResize(event) {
        const state = this.resizeState;
        if (!state || state.pointerId !== event.pointerId) return;
        event.preventDefault();
        if (!this.floating) {
            const maximum = Math.max(MIN_PANEL_HEIGHT, state.bounds.top + state.bounds.height - FLOATING_MARGIN);
            const height = clamp(state.bounds.height - (event.clientY - state.startY), MIN_PANEL_HEIGHT, maximum);
            this.panel.style.height = `${height}px`;
            return;
        }
        const bounds = resizeFloatingPanel(
            state.bounds,
            state.direction,
            {
                x: event.clientX - state.startX,
                y: event.clientY - state.startY,
            },
            { width: window.innerWidth, height: window.innerHeight },
        );
        this.panel.style.left = `${bounds.left}px`;
        this.panel.style.top = `${bounds.top}px`;
        this.panel.style.width = `${bounds.width}px`;
        this.panel.style.height = `${bounds.height}px`;
    }

    #finishPanelResize(event) {
        const state = this.resizeState;
        if (!state || state.pointerId !== event.pointerId) return;
        if (state.handle.hasPointerCapture(event.pointerId)) {
            state.handle.releasePointerCapture(event.pointerId);
        }
        this.resizeState = null;
        if (this.floating) this.#savePanelSize();
        else this.#saveInputPanelHeight();
    }

    #restoreInputPanelHeight() {
        let height = Math.min(620, window.innerHeight * 0.52);
        try {
            const saved = Number.parseFloat(localStorage.getItem(INPUT_PANEL_HEIGHT_KEY));
            if (Number.isFinite(saved)) height = saved;
        } catch {
            // 浏览器禁用本地存储时使用默认高度
        }
        const anchorTop = this.root.parentElement?.getBoundingClientRect().top ?? window.innerHeight;
        const maximum = Math.max(MIN_PANEL_HEIGHT, anchorTop - FLOATING_MARGIN);
        this.panel.style.height = `${clamp(height, MIN_PANEL_HEIGHT, maximum)}px`;
    }

    #saveInputPanelHeight() {
        const height = this.panel.getBoundingClientRect().height;
        try {
            localStorage.setItem(INPUT_PANEL_HEIGHT_KEY, String(height));
        } catch {
            // 浏览器禁用本地存储时仍保留当前会话高度
        }
    }

    #restorePosition() {
        const fallback = {
            x: window.innerWidth - DEFAULT_BUBBLE_SIZE - 20,
            y: window.innerHeight - DEFAULT_BUBBLE_SIZE - 110,
        };
        let position = fallback;
        try {
            const saved = JSON.parse(localStorage.getItem(POSITION_KEY));
            if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) position = saved;
        } catch {
            localStorage.removeItem(POSITION_KEY);
        }
        this.#applyPosition(clampFloatingPosition(
            position,
            { width: DEFAULT_BUBBLE_SIZE, height: DEFAULT_BUBBLE_SIZE },
            { width: window.innerWidth, height: window.innerHeight },
        ));
    }

    #savePosition() {
        const rect = this.root.getBoundingClientRect();
        try {
            localStorage.setItem(POSITION_KEY, JSON.stringify({ x: rect.left, y: rect.top }));
        } catch {
            // 浏览器禁用本地存储时仍保留当前会话位置
        }
    }

    #restorePanelSize() {
        const fallback = {
            width: Math.min(760, window.innerWidth - FLOATING_MARGIN * 2),
            height: Math.min(620, window.innerHeight * 0.52),
        };
        let size = fallback;
        try {
            const saved = JSON.parse(localStorage.getItem(PANEL_SIZE_KEY));
            if (Number.isFinite(saved?.width) && Number.isFinite(saved?.height)) size = saved;
        } catch {
            localStorage.removeItem(PANEL_SIZE_KEY);
        }
        this.preferredPanelSize = size;
        this.#setPanelSize(size.width, size.height);
    }

    #savePanelSize() {
        const rect = this.panel.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        this.preferredPanelSize = { width: rect.width, height: rect.height };
        try {
            localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(this.preferredPanelSize));
        } catch {
            // 浏览器禁用本地存储时仍保留当前会话尺寸
        }
    }

    #fitPanelToViewport() {
        if (!this.floating) return;
        const rect = this.panel.getBoundingClientRect();
        const width = this.preferredPanelSize?.width
            ?? rect.width
            ?? Number.parseFloat(this.panel.style.width);
        const height = this.preferredPanelSize?.height
            ?? rect.height
            ?? Number.parseFloat(this.panel.style.height);
        this.#setPanelSize(width, height);
    }

    #setPanelSize(width, height) {
        const maxWidth = window.innerWidth - FLOATING_MARGIN * 2;
        const maxHeight = window.innerHeight - FLOATING_MARGIN * 2;
        this.panel.style.width = `${clamp(width, Math.min(MIN_PANEL_WIDTH, maxWidth), maxWidth)}px`;
        this.panel.style.height = `${clamp(height, Math.min(MIN_PANEL_HEIGHT, maxHeight), maxHeight)}px`;
    }

    #keepBubbleVisible() {
        if (!this.root || !this.floating) return;
        const rect = this.root.getBoundingClientRect();
        this.#applyPosition(clampFloatingPosition(
            { x: rect.left, y: rect.top },
            { width: rect.width || DEFAULT_BUBBLE_SIZE, height: rect.height || DEFAULT_BUBBLE_SIZE },
            { width: window.innerWidth, height: window.innerHeight },
        ));
        this.#savePosition();
    }

    #applyPosition(position) {
        this.root.style.left = `${position.x}px`;
        this.root.style.top = `${position.y}px`;
    }

    #positionPanel() {
        if (!this.floating || !this.opened || !this.panel || this.panel.hidden) return;
        const bubble = this.root.getBoundingClientRect();
        const panel = this.panel.getBoundingClientRect();
        const position = placeFloatingPanel(bubble, panel, {
            width: window.innerWidth,
            height: window.innerHeight,
        });
        this.panel.style.left = `${position.left}px`;
        this.panel.style.top = `${position.top}px`;
    }
}

/**
 * 将悬浮气泡限制在当前视口内
 * @param {object} position 期望坐标
 * @param {number} position.x 横坐标
 * @param {number} position.y 纵坐标
 * @param {object} size 气泡尺寸
 * @param {number} size.width 宽度
 * @param {number} size.height 高度
 * @param {object} viewport 视口尺寸
 * @param {number} viewport.width 视口宽度
 * @param {number} viewport.height 视口高度
 * @returns {object} 可见坐标
 */
export function clampFloatingPosition(position, size, viewport) {
    return {
        x: clamp(position.x, FLOATING_MARGIN, viewport.width - size.width - FLOATING_MARGIN),
        y: clamp(position.y, FLOATING_MARGIN, viewport.height - size.height - FLOATING_MARGIN),
    };
}

/**
 * 根据拖动方向调整面板边界并限制在视口内
 * @param {object} bounds 初始边界
 * @param {number} bounds.left 左边界
 * @param {number} bounds.top 上边界
 * @param {number} bounds.width 宽度
 * @param {number} bounds.height 高度
 * @param {string} direction 拖动方向
 * @param {object} delta 指针位移
 * @param {number} delta.x 横向位移
 * @param {number} delta.y 纵向位移
 * @param {object} viewport 视口尺寸
 * @param {number} viewport.width 视口宽度
 * @param {number} viewport.height 视口高度
 * @returns {object} 调整后的边界
 */
export function resizeFloatingPanel(bounds, direction, delta, viewport) {
    let left = bounds.left;
    let top = bounds.top;
    let right = bounds.left + bounds.width;
    let bottom = bounds.top + bounds.height;
    const minWidth = Math.min(MIN_PANEL_WIDTH, viewport.width - FLOATING_MARGIN * 2);
    const minHeight = Math.min(MIN_PANEL_HEIGHT, viewport.height - FLOATING_MARGIN * 2);
    if (direction.includes('w')) {
        left = clamp(left + delta.x, FLOATING_MARGIN, right - minWidth);
    }
    if (direction.includes('e')) {
        right = clamp(right + delta.x, left + minWidth, viewport.width - FLOATING_MARGIN);
    }
    if (direction.includes('n')) {
        top = clamp(top + delta.y, FLOATING_MARGIN, bottom - minHeight);
    }
    if (direction.includes('s')) {
        bottom = clamp(bottom + delta.y, top + minHeight, viewport.height - FLOATING_MARGIN);
    }
    return { left, top, width: right - left, height: bottom - top };
}

/**
 * 以气泡为中心放置面板，只移动位置而不改变窗口尺寸
 * @param {object} bubble 气泡边界
 * @param {number} bubble.left 左边界
 * @param {number} bubble.top 上边界
 * @param {number} bubble.bottom 下边界
 * @param {number} bubble.width 宽度
 * @param {object} panel 面板尺寸
 * @param {number} panel.width 宽度
 * @param {number} panel.height 高度
 * @param {object} viewport 视口尺寸
 * @param {number} viewport.width 视口宽度
 * @param {number} viewport.height 视口高度
 * @returns {object} 面板坐标
 */
export function placeFloatingPanel(bubble, panel, viewport) {
    const left = clamp(
        bubble.left + bubble.width / 2 - panel.width / 2,
        FLOATING_MARGIN,
        viewport.width - panel.width - FLOATING_MARGIN,
    );
    const below = bubble.bottom + FLOATING_MARGIN;
    const above = bubble.top - panel.height - FLOATING_MARGIN;
    const top = below + panel.height <= viewport.height - FLOATING_MARGIN
        ? below
        : clamp(above, FLOATING_MARGIN, viewport.height - panel.height - FLOATING_MARGIN);
    return { left, top };
}

function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function createLoadingState() {
    const loading = element('div', { className: 'prompt-control-loading' });
    loading.append(
        element('i', { className: 'fa-solid fa-circle-notch prompt-control-loading-icon' }),
        element('span', { text: '正在读取本轮提示词…' }),
    );
    return loading;
}

function formatNumber(value) {
    return new Intl.NumberFormat().format(Number(value) || 0);
}

function summarizeContent(content) {
    return String(content ?? '').trim().replace(/\s+/g, ' ').slice(0, 320) || '空内容';
}

function summarizeItems(items, getContent) {
    return summarizeContent(items.map(getContent).filter(Boolean).join(' '));
}

function sumTokens(items) {
    return items.reduce((total, item) => total + (Number(item.tokenCount) || 0), 0);
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

function requireInput(root, selector) {
    const value = root.querySelector(selector);
    if (!(value instanceof HTMLInputElement)) throw new Error(`本轮提示词模板缺少 ${selector}`);
    return value;
}
