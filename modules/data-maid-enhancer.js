import { formatBytes, parseJsonlResponse } from './utils.js';

const MATCH_CONCURRENCY = 4;
const PAGE_SIZE = 50;

/**
 * 根据稳定完整性标识判断备份对应状态
 * @param {string} integrity 备份完整性标识
 * @param {Set<string>} activeIntegrities 现有聊天完整性标识
 * @returns {'linked'|'orphan'|'uncertain'} 对应状态
 */
export function classifyBackupIntegrity(integrity, activeIntegrities) {
    if (!integrity) return 'uncertain';
    return activeIntegrities.has(integrity) ? 'linked' : 'orphan';
}

function notify(type, message) {
    if (globalThis.toastr?.[type]) globalThis.toastr[type](message);
    else console[type === 'error' ? 'error' : 'log'](message);
}

/**
 * 等待酒馆动态创建指定元素
 * @param {string} selector 选择器
 * @param {number} timeout 超时时间
 * @returns {Promise<Element>} 匹配元素
 */
function waitForElement(selector, timeout = 15_000) {
    const existing = document.querySelector(selector);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => {
            const element = document.querySelector(selector);
            if (!element) return;
            clearTimeout(timer);
            observer.disconnect();
            resolve(element);
        });
        const timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error('等待酒馆数据清理面板超时'));
        }, timeout);
        observer.observe(document.body, { childList: true, subtree: true });
    });
}

export class DataMaidEnhancer {
    /**
     * @param {object} dependencies 依赖项
     * @param {import('./api.js').ChatManagerApi} dependencies.api 酒馆接口
     * @param {string} dependencies.template 增强控件模板
     */
    constructor({ api, template }) {
        this.api = api;
        this.token = '';
        this.reportItems = [];
        this.items = new Map();
        this.selected = new Map();
        this.category = null;
        this.container = null;
        this.controller = null;
        this.sessionObserver = null;
        this.viewerController = null;
        this.pendingDelete = [];
        this.pendingCapture = null;
        this.filter = 'all';
        this.busy = false;
        this.#build(template);
        this.documentClick = event => this.#handleDocumentClick(event);
        this.enabled = true;
        document.addEventListener('click', this.documentClick, true);
    }

    /** @param {string} template 静态增强模板 */
    #build(template) {
        const holder = document.createElement('template');
        holder.innerHTML = template.trim();
        const root = holder.content.firstElementChild;
        if (!(root instanceof HTMLElement)) throw new Error('数据清理增强模板无效');
        const required = (selector, type = HTMLElement) => {
            const node = root.querySelector(selector);
            if (!(node instanceof type)) throw new Error(`数据清理增强模板缺少 ${selector}`);
            return node;
        };
        this.root = root;
        this.toolbarTemplate = required('[data-cm-maid-toolbar-template]', HTMLTemplateElement);
        this.controlsTemplate = required('[data-cm-maid-controls-template]', HTMLTemplateElement);
        this.messageTemplate = required('[data-cm-maid-message-template]', HTMLTemplateElement);
        this.deleteTemplate = required('[data-cm-maid-delete-template]', HTMLTemplateElement);
        this.viewer = required('[data-cm-maid-viewer]');
        this.viewerTitle = required('[data-cm-maid-viewer-title]');
        this.viewerSummary = required('[data-cm-maid-viewer-summary]');
        this.messages = required('[data-cm-maid-messages]');
        this.messagePrevious = required('[data-cm-maid-message-previous]', HTMLButtonElement);
        this.messageNext = required('[data-cm-maid-message-next]', HTMLButtonElement);
        this.messagePage = required('[data-cm-maid-message-page]');
        this.deleteDialog = required('[data-cm-maid-delete-dialog]');
        this.deleteSummary = required('[data-cm-maid-delete-summary]');
        this.deleteList = required('[data-cm-maid-delete-list]');
        this.deleteCancel = required('[data-cm-maid-delete-cancel]', HTMLButtonElement);
        this.deleteConfirm = required('[data-cm-maid-delete-confirm]', HTMLButtonElement);
        required('[data-cm-maid-viewer-close]', HTMLButtonElement).addEventListener('click', () => this.#closeViewer());
        required('[data-cm-maid-delete-close]', HTMLButtonElement).addEventListener('click', () => this.#closeDelete());
        this.deleteCancel.addEventListener('click', () => this.#closeDelete());
        this.deleteConfirm.addEventListener('click', () => void this.#executeDelete());
        document.body.append(root);
    }

    /** 打开酒馆原生数据清理面板 */
    async open() {
        if (document.querySelector('.dataMaidDialogContainer')) {
            notify('warning', '酒馆数据清理面板已经打开，请关闭后从聊天管理重新进入');
            return;
        }
        const button = document.querySelector('#data_maid_button');
        if (!(button instanceof HTMLElement)) throw new Error('当前酒馆版本没有可用的数据清理入口');
        button.click();
    }

    /** @param {boolean} enabled 是否启用原生面板增强 */
    setEnabled(enabled) {
        if (this.enabled === enabled) return;
        this.enabled = enabled;
        if (enabled) document.addEventListener('click', this.documentClick, true);
        else {
            document.removeEventListener('click', this.documentClick, true);
            this.#resetSession();
        }
    }

    /** @param {Event} event 文档捕获阶段点击事件 */
    #handleDocumentClick(event) {
        if (!this.enabled) return;
        const target = event.target instanceof Element ? event.target.closest('.dataMaidStartButton') : null;
        if (!(target instanceof HTMLButtonElement)) return;
        const container = target.closest('.dataMaidDialogContainer');
        if (!(container instanceof HTMLElement)) return;
        const spinner = container.querySelector('.dataMaidSpinner');
        if (spinner && !spinner.classList.contains('displayNone')) return;
        this.#prepareSession(container);
    }

    /** @param {HTMLElement} container 酒馆原生数据清理容器 */
    #prepareSession(container) {
        this.#resetSession();
        this.container = container;
        this.#watchSession();
        const capture = this.#captureNextReport();
        this.pendingCapture = capture;
        void capture.promise.then(async result => {
            if (this.pendingCapture !== capture) return;
            this.pendingCapture = null;
            if (!result?.token || !Array.isArray(result.report?.chatBackups)) throw new Error('酒馆数据清理报告格式无效');
            this.token = result.token;
            this.reportItems = result.report.chatBackups;
            await this.#enhanceCategory();
        }).catch(error => {
            if (error?.name !== 'AbortError') notify('error', error.message);
        });
    }

    /**
     * 一次性观察原生报告请求，不修改请求或响应内容
     * @returns {{promise:Promise<object>,cancel:()=>void}} 捕获任务
     */
    #captureNextReport() {
        const original = globalThis.fetch;
        let settled = false;
        let rejectCapture;
        let wrapped;
        let timer;
        const restore = () => {
            if (globalThis.fetch === wrapped) globalThis.fetch = original;
            clearTimeout(timer);
        };
        const promise = new Promise((resolve, reject) => {
            rejectCapture = reject;
            function finish(value, error) {
                if (settled) return;
                settled = true;
                restore();
                if (error) reject(error);
                else resolve(value);
            }
            wrapped = async function (input, init) {
                const response = await original.call(globalThis, input, init);
                const url = typeof input === 'string' ? input : input?.url;
                if (String(url ?? '').includes('/api/data-maid/report')) {
                    try {
                        finish(await response.clone().json());
                    } catch (error) {
                        finish(null, error);
                    }
                }
                return response;
            };
            // 捕获阶段先安装一次性观察器，让原生冒泡处理器仍独占扫描与渲染
            globalThis.fetch = wrapped;
        });
        timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            restore();
            rejectCapture(new Error('等待酒馆数据清理报告超时'));
        }, 120_000);
        return {
            promise,
            cancel: () => {
                if (settled) return;
                settled = true;
                restore();
                rejectCapture(new DOMException('操作已取消', 'AbortError'));
            },
        };
    }

    /** 定位聊天备份分类并插入增强控件 */
    async #enhanceCategory() {
        if (!this.reportItems.length) {
            notify('info', '当前没有聊天备份文件');
            return;
        }
        const firstHash = CSS.escape(this.reportItems[0].hash);
        const item = await waitForElement(`.dataMaidItem[data-hash="${firstHash}"]`, 30_000);
        const category = item.closest('.dataMaidCategory');
        if (!(category instanceof HTMLElement)) throw new Error('找不到酒馆聊天备份分类');
        this.category = category;
        category.classList.add('cm-data-maid-enhanced');
        this.items = new Map(this.reportItems.map(record => [record.hash, { record, state: 'unchecked', element: null }]));
        const content = category.querySelector('.dataMaidCategoryContent');
        if (!(content instanceof HTMLElement)) throw new Error('酒馆聊天备份分类结构无效');
        const toolbar = this.toolbarTemplate.content.firstElementChild.cloneNode(true);
        content.prepend(toolbar);
        this.toolbar = toolbar;
        this.scanButton = toolbar.querySelector('[data-cm-maid-scan]');
        this.search = toolbar.querySelector('[data-cm-maid-search]');
        this.sort = toolbar.querySelector('[data-cm-maid-sort]');
        this.filterSelect = toolbar.querySelector('[data-cm-maid-filter]');
        this.selectAll = toolbar.querySelector('[data-cm-maid-select-all]');
        this.deleteSelected = toolbar.querySelector('[data-cm-maid-delete-selected]');
        this.selectedCount = toolbar.querySelector('[data-cm-maid-selected-count]');
        this.progress = toolbar.querySelector('[data-cm-maid-progress]');
        this.scanButton.addEventListener('click', () => void this.#inspectBackups());
        this.search.addEventListener('input', () => this.#applyFilter());
        this.sort.addEventListener('change', () => this.#applyFilter());
        this.filterSelect.addEventListener('change', () => {
            this.filter = this.filterSelect.value;
            this.#applyFilter();
        });
        this.selectAll.addEventListener('click', () => this.#toggleSelectAll());
        this.deleteSelected.addEventListener('click', () => this.#showDelete(Array.from(this.selected.values())));
        for (const element of category.querySelectorAll('.dataMaidItem')) this.#enhanceItem(element);
        this.#syncSelection();
    }

    /** @param {Element} element 原生备份条目 */
    #enhanceItem(element) {
        const hash = element.getAttribute('data-hash');
        const item = this.items.get(hash);
        if (!item || !(element instanceof HTMLElement)) return;
        item.element = element;
        const header = element.querySelector('.dataMaidItemHeader');
        const nativeView = element.querySelector('.dataMaidItemView');
        if (!(header instanceof HTMLElement)) return;
        nativeView?.classList.add('cm-hidden');
        const controls = this.controlsTemplate.content.firstElementChild.cloneNode(true);
        header.prepend(controls);
        const checkbox = controls.querySelector('[data-cm-maid-select]');
        const badge = controls.querySelector('[data-cm-maid-state]');
        const view = controls.querySelector('[data-cm-maid-view]');
        item.checkbox = checkbox;
        item.badge = badge;
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) this.selected.set(hash, item);
            else this.selected.delete(hash);
            element.classList.toggle('cm-selected', checkbox.checked);
            this.#syncSelection();
        });
        view.addEventListener('click', () => void this.#viewItem(item));
    }

    /** 检查每个备份的完整性标识并原位更新状态 */
    async #inspectBackups() {
        this.controller?.abort();
        this.controller = new AbortController();
        const signal = this.controller.signal;
        this.#setBusy(true);
        try {
            this.progress.textContent = '正在读取现有聊天标识…';
            const chats = await this.api.listChatFiles(signal);
            if (!Array.isArray(chats)) throw new Error('聊天文件接口返回格式无效');
            const activeIntegrities = new Set(chats.map(item => String(item.chat_metadata?.integrity ?? '')).filter(Boolean));
            const items = Array.from(this.items.values()).filter(item => item.element?.isConnected);
            let cursor = 0;
            let done = 0;
            const run = async () => {
                while (cursor < items.length) {
                    const item = items[cursor++];
                    let integrity = null;
                    try {
                        const response = await this.api.readDataMaidFile(this.token, item.record.hash, signal);
                        await parseJsonlResponse(response, {
                            stopAfter: 0,
                            onHeader: header => { integrity = header.chat_metadata?.integrity ?? null; },
                        });
                        item.state = classifyBackupIntegrity(integrity, activeIntegrities);
                    } catch (error) {
                        if (signal.aborted) throw error;
                        item.state = 'uncertain';
                    }
                    this.#renderState(item);
                    done++;
                    this.progress.textContent = `正在检查备份 · ${done} / ${items.length}`;
                }
            };
            await Promise.all(Array.from({ length: Math.min(MATCH_CONCURRENCY, items.length) }, () => run()));
            const orphan = items.filter(item => item.state === 'orphan').length;
            const uncertain = items.filter(item => item.state === 'uncertain').length;
            this.progress.textContent = `检查完成 · 孤立 ${orphan} · 待确认 ${uncertain}`;
            this.filter = 'issues';
            this.filterSelect.value = 'issues';
            this.#applyFilter();
        } catch (error) {
            if (!signal.aborted) notify('error', error.message);
        } finally {
            this.#setBusy(false);
        }
    }

    /** @param {object} item 备份增强条目 */
    #renderState(item) {
        const labels = { linked: '已关联', orphan: '孤立', uncertain: '待确认', unchecked: '未检查' };
        item.badge.textContent = labels[item.state] ?? '待确认';
        item.badge.dataset.state = item.state;
    }

    #applyFilter() {
        const query = this.search?.value.trim().toLowerCase() ?? '';
        for (const item of this.items.values()) {
            const stateVisible = this.filter === 'all' || ['orphan', 'uncertain'].includes(item.state);
            const queryVisible = !query || `${item.record.name} ${item.state}`.toLowerCase().includes(query);
            const visible = stateVisible && queryVisible;
            item.element?.classList.toggle('cm-hidden', !visible);
            if (!visible && this.selected.has(item.record.hash)) {
                this.selected.delete(item.record.hash);
                item.checkbox.checked = false;
                item.element?.classList.remove('cm-selected');
            }
        }
        const list = this.category?.querySelector('.dataMaidCategoryContent > .flex-container');
        if (list) {
            const sorted = Array.from(this.items.values()).filter(item => item.element?.isConnected).sort((a, b) => {
                if (this.sort?.value === 'oldest') return Number(a.record.mtime ?? 0) - Number(b.record.mtime ?? 0);
                if (this.sort?.value === 'largest') return Number(b.record.size ?? 0) - Number(a.record.size ?? 0);
                return Number(b.record.mtime ?? 0) - Number(a.record.mtime ?? 0);
            });
            for (const item of sorted) list.append(item.element);
        }
        this.#syncSelection();
    }

    #toggleSelectAll() {
        const visible = Array.from(this.items.values()).filter(item => item.element?.isConnected && !item.element.classList.contains('cm-hidden'));
        const allSelected = visible.length > 0 && visible.every(item => this.selected.has(item.record.hash));
        for (const item of visible) {
            item.checkbox.checked = !allSelected;
            if (allSelected) this.selected.delete(item.record.hash);
            else this.selected.set(item.record.hash, item);
            item.element.classList.toggle('cm-selected', !allSelected);
        }
        this.#syncSelection();
    }

    #syncSelection() {
        if (!this.toolbar) return;
        for (const [hash, item] of this.selected) {
            if (!item.element?.isConnected) this.selected.delete(hash);
        }
        const visible = Array.from(this.items.values()).filter(item => item.element?.isConnected && !item.element.classList.contains('cm-hidden'));
        const allSelected = visible.length > 0 && visible.every(item => this.selected.has(item.record.hash));
        this.selectAll.disabled = this.busy || visible.length === 0;
        this.selectAll.textContent = allSelected ? '取消全选当前结果' : '全选当前结果';
        this.deleteSelected.disabled = this.busy || this.selected.size === 0;
        this.selectedCount.textContent = `删除已选（${this.selected.size}）`;
    }

    /** @param {object} item 备份增强条目 */
    async #viewItem(item) {
        this.viewerController?.abort();
        this.viewerController = new AbortController();
        const signal = this.viewerController.signal;
        let page = 0;
        this.viewer.classList.remove('cm-hidden');
        this.viewerTitle.textContent = '查看聊天备份';
        this.viewerSummary.textContent = `${item.record.name} · ${formatBytes(Number(item.record.size ?? 0))}`;
        const load = async () => {
            this.messages.replaceChildren();
            const loading = document.createElement('div');
            loading.className = 'cm-state';
            loading.textContent = '正在读取该页…';
            this.messages.append(loading);
            try {
                const start = page * PAGE_SIZE;
                const collected = [];
                const response = await this.api.readDataMaidFile(this.token, item.record.hash, signal);
                await parseJsonlResponse(response, {
                    stopAfter: start + PAGE_SIZE + 1,
                    onMessage: (message, index) => {
                        if (index >= start && index <= start + PAGE_SIZE) collected.push(message);
                    },
                });
                const messages = collected.slice(0, PAGE_SIZE);
                this.messages.replaceChildren(...messages.map((message, index) => this.#message(message, start + index)));
                if (!messages.length) this.messages.append(loading);
                this.messagePage.textContent = `第 ${page + 1} 页`;
                this.messagePrevious.disabled = page <= 0;
                this.messageNext.disabled = collected.length <= PAGE_SIZE;
            } catch (error) {
                if (signal.aborted) return;
                loading.textContent = error.message;
                loading.classList.add('cm-error');
                this.messages.replaceChildren(loading);
            }
        };
        this.messagePrevious.onclick = () => { page--; void load(); };
        this.messageNext.onclick = () => { page++; void load(); };
        await load();
    }

    #message(message, index) {
        const row = this.messageTemplate.content.firstElementChild.cloneNode(true);
        row.querySelector('[data-cm-message-name]').textContent = `#${index} ${message.name ?? ''}`;
        row.querySelector('[data-cm-message-date]').textContent = this.#formatDate(message.send_date);
        row.querySelector('[data-cm-message-content]').textContent = String(message.mes ?? '');
        return row;
    }

    /** @param {object[]} items 待删除备份 */
    #showDelete(items) {
        const unique = Array.from(new Map(items.map(item => [item.record.hash, item])).values());
        if (!unique.length) return;
        this.pendingDelete = unique;
        this.deleteList.replaceChildren(...unique.map(item => {
            const row = this.deleteTemplate.content.firstElementChild.cloneNode(true);
            row.querySelector('[data-cm-delete-name]').textContent = item.record.name;
            row.querySelector('[data-cm-delete-facts]').textContent = `${formatBytes(Number(item.record.size ?? 0))} · ${this.#formatDate(item.record.mtime)}`;
            const labels = { linked: '已关联', orphan: '孤立', uncertain: '待确认', unchecked: '未检查' };
            row.querySelector('[data-cm-delete-state]').textContent = labels[item.state] ?? '待确认';
            return row;
        }));
        this.deleteSummary.textContent = `${unique.length} 个聊天备份 · ${formatBytes(unique.reduce((sum, item) => sum + Number(item.record.size ?? 0), 0))}`;
        this.deleteConfirm.disabled = false;
        this.deleteCancel.disabled = false;
        this.deleteDialog.classList.remove('cm-hidden');
    }

    async #executeDelete() {
        if (!this.token || !this.pendingDelete.length) return;
        const items = [...this.pendingDelete];
        this.deleteConfirm.disabled = true;
        this.deleteCancel.disabled = true;
        try {
            await this.api.deleteDataMaidFiles(this.token, items.map(item => item.record.hash));
            for (const item of items) {
                item.element?.remove();
                this.items.delete(item.record.hash);
                this.selected.delete(item.record.hash);
            }
            this.pendingDelete = [];
            this.#closeDelete(true);
            this.#syncSelection();
            this.#updateNativeSummary();
            notify('success', `已删除 ${items.length} 个聊天备份`);
        } catch (error) {
            this.deleteSummary.textContent = `删除失败：${error.message}`;
            this.deleteCancel.disabled = false;
            notify('error', error.message);
        }
    }

    #updateNativeSummary() {
        if (!this.category) return;
        const records = Array.from(this.items.values()).filter(item => item.element?.isConnected);
        const info = this.category.querySelectorAll('.dataMaidCategoryInfo small');
        if (info[0]) info[0].lastChild.textContent = ` ${records.length}`;
        if (info[1]) info[1].lastChild.textContent = ` ${formatBytes(records.reduce((sum, item) => sum + Number(item.record.size ?? 0), 0))}`;
    }

    #setBusy(busy) {
        this.busy = busy;
        this.category?.classList.toggle('cm-data-maid-busy', busy);
        if (this.scanButton) this.scanButton.disabled = busy;
        for (const item of this.items.values()) {
            if (item.checkbox) item.checkbox.disabled = busy;
        }
        for (const button of this.category?.querySelectorAll('.dataMaidItemDelete') ?? []) {
            if (button instanceof HTMLButtonElement) button.disabled = busy;
        }
        this.category?.querySelector('.dataMaidDeleteAll')?.setAttribute('aria-disabled', String(busy));
        this.#syncSelection();
    }

    #watchSession() {
        this.sessionObserver?.disconnect();
        this.sessionObserver = new MutationObserver(() => {
            if (this.container?.isConnected) return;
            this.#resetSession();
        });
        this.sessionObserver.observe(document.body, { childList: true, subtree: true });
    }

    #closeViewer() {
        this.viewerController?.abort();
        this.viewerController = null;
        this.viewer.classList.add('cm-hidden');
    }

    #closeDelete(force = false) {
        if (!force && this.deleteConfirm.disabled && this.deleteCancel.disabled) return;
        this.pendingDelete = [];
        this.deleteDialog.classList.add('cm-hidden');
    }

    #resetSession() {
        this.pendingCapture?.cancel();
        this.pendingCapture = null;
        this.controller?.abort();
        this.controller = null;
        this.sessionObserver?.disconnect();
        this.sessionObserver = null;
        this.#closeViewer();
        this.#closeDelete(true);
        this.selected.clear();
        this.category?.classList.remove('cm-data-maid-enhanced', 'cm-data-maid-busy');
        this.category?.querySelector('.cm-data-maid-tools')?.remove();
        for (const controls of this.category?.querySelectorAll('.cm-data-maid-controls') ?? []) controls.remove();
        for (const view of this.category?.querySelectorAll('.dataMaidItemView') ?? []) view.classList.remove('cm-hidden');
        this.items.clear();
        this.token = '';
        this.reportItems = [];
        this.busy = false;
        this.category = null;
        this.container = null;
        this.toolbar = null;
    }

    #formatDate(value) {
        const time = new Date(value ?? 0).valueOf();
        if (!Number.isFinite(time) || !time) return '未知时间';
        return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(time));
    }
}
