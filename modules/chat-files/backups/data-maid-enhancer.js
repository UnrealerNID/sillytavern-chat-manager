import { formatBytes } from '../../shared/files.js';
import { waitForElement } from '../../platform/dom.js';
import { captureNextDataMaidReport } from './data-maid-report.js';
import { DataMaidSelection } from './data-maid-selection.js';
import {
    backupStateMatchesFilter,
    inspectDataMaidBackups,
} from './data-maid-inspector.js';
import { DataMaidViewer, formatDataMaidDate } from '../ui/data-maid-viewer.js';

const BACKUP_STATE_LABELS = {
    linked: '已关联',
    orphan: '孤立',
    uncertain: '待确认',
    unchecked: '未检查',
};

function notify(type, message) {
    if (globalThis.toastr?.[type]) globalThis.toastr[type](message);
    else console[type === 'error' ? 'error' : 'log'](message);
}

export class DataMaidEnhancer {
    /**
     * @param {object} dependencies 依赖项
     * @param {import('../api.js').ChatManagerApi} dependencies.api 酒馆接口
     * @param {string} dependencies.template 增强控件模板
     */
    constructor({ api, template }) {
        this.api = api;
        this.token = '';
        this.reportItems = [];
        this.items = new Map();
        this.category = null;
        this.container = null;
        this.controller = null;
        this.sessionObserver = null;
        this.pendingDelete = [];
        this.pendingCapture = null;
        this.filter = 'all';
        this.busy = false;
        this.selection = new DataMaidSelection({
            getItems: () => this.items,
            isBusy: () => this.busy,
            onDelete: items => this.#showDelete(items),
        });
        this.#build(template);
        this.documentClick = event => this.#handleDocumentClick(event);
        this.enabled = false;
    }

    /**
     * 构建增强面板
     * @param {string} template 静态增强模板
     */
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
        this.toolbarTemplate = required('[data-cm-maid-toolbar-template]', HTMLTemplateElement);
        this.controlsTemplate = required('[data-cm-maid-controls-template]', HTMLTemplateElement);
        this.messageTemplate = required('[data-cm-maid-message-template]', HTMLTemplateElement);
        this.deleteTemplate = required('[data-cm-maid-delete-template]', HTMLTemplateElement);
        this.viewer = new DataMaidViewer({
            api: this.api,
            messageTemplate: this.messageTemplate,
            required,
        });
        this.deleteDialog = required('[data-cm-maid-delete-dialog]');
        this.deleteSummary = required('[data-cm-maid-delete-summary]');
        this.deleteList = required('[data-cm-maid-delete-list]');
        this.deleteCancel = required('[data-cm-maid-delete-cancel]', HTMLButtonElement);
        this.deleteConfirm = required('[data-cm-maid-delete-confirm]', HTMLButtonElement);
        const closeDelete = required('[data-cm-maid-delete-close]', HTMLButtonElement);
        closeDelete.addEventListener('click', () => this.#closeDelete());
        this.deleteCancel.addEventListener('click', () => this.#closeDelete());
        this.deleteConfirm.addEventListener('click', () => void this.#executeDelete());
        document.body.append(root);
    }

    /**
     * 打开酒馆原生数据清理面板
     */
    async open() {
        if (document.querySelector('.dataMaidDialogContainer')) {
            notify('warning', '酒馆数据清理面板已经打开，请关闭后从聊天管理重新进入');
            return;
        }
        const button = document.querySelector('#data_maid_button');
        if (!(button instanceof HTMLElement)) throw new Error('当前酒馆版本没有可用的数据清理入口');
        button.click();
    }

    /**
     * 设置原生面板增强状态
     * @param {boolean} enabled 是否启用
     */
    setEnabled(enabled) {
        if (this.enabled === enabled) return;
        this.enabled = enabled;
        if (enabled) document.addEventListener('click', this.documentClick, true);
        else {
            document.removeEventListener('click', this.documentClick, true);
            this.#resetSession();
        }
    }

    /**
     * 处理文档捕获阶段点击事件
     * @param {Event} event 点击事件
     */
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

    /**
     * 准备一次数据清理会话
     * @param {HTMLElement} container 原生数据清理容器
     */
    #prepareSession(container) {
        this.#resetSession();
        this.container = container;
        this.controller = new AbortController();
        this.#watchSession();
        const capture = captureNextDataMaidReport();
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
     * 定位聊天备份分类并插入增强控件
     */
    async #enhanceCategory() {
        if (!this.reportItems.length) {
            notify('info', '当前没有聊天备份文件');
            return;
        }
        const firstHash = CSS.escape(this.reportItems[0].hash);
        const item = await waitForElement(`.dataMaidItem[data-hash="${firstHash}"]`, {
            timeout: 30_000,
            signal: this.controller?.signal,
        });
        const category = item.closest('.dataMaidCategory');
        if (!(category instanceof HTMLElement)) throw new Error('找不到酒馆聊天备份分类');
        this.category = category;
        category.classList.add('cm-data-maid-enhanced');
        this.items = new Map(this.reportItems.map(record => [record.hash, {
            record,
            state: 'unchecked',
            element: null,
        }]));
        const content = category.querySelector('.dataMaidCategoryContent');
        if (!(content instanceof HTMLElement)) throw new Error('酒馆聊天备份分类结构无效');
        const toolbar = this.toolbarTemplate.content.firstElementChild.cloneNode(true);
        content.prepend(toolbar);
        this.scanButton = toolbar.querySelector('[data-cm-maid-scan]');
        this.search = toolbar.querySelector('[data-cm-maid-search]');
        this.sort = toolbar.querySelector('[data-cm-maid-sort]');
        this.filterSelect = toolbar.querySelector('[data-cm-maid-filter]');
        this.progress = toolbar.querySelector('[data-cm-maid-progress]');
        this.scanButton.addEventListener('click', () => void this.#inspectBackups());
        this.search.addEventListener('input', () => this.#applyFilter());
        this.sort.addEventListener('change', () => this.#applyFilter());
        this.filterSelect.addEventListener('change', () => {
            this.filter = this.filterSelect.value;
            this.#applyFilter();
        });
        this.selection.mount({
            category,
            batchStart: toolbar.querySelector('[data-cm-maid-batch-start]'),
            selectionToolbar: toolbar.querySelector('[data-cm-maid-selection-toolbar]'),
            selectAll: toolbar.querySelector('[data-cm-maid-select-all]'),
            clearSelection: toolbar.querySelector('[data-cm-maid-clear-selection]'),
            deleteSelected: toolbar.querySelector('[data-cm-maid-delete-selected]'),
            selectedCount: toolbar.querySelector('[data-cm-maid-selected-count]'),
        });
        for (const element of category.querySelectorAll('.dataMaidItem')) this.#enhanceItem(element);
    }

    /**
     * 增强原生备份条目
     * @param {Element} element 原生备份条目
     */
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
        this.selection.bindItem(item);
        view.addEventListener('click', () => void this.viewer.open(item, this.token));
    }

    /**
     * 检查每个备份的完整性标识并原位更新状态
     */
    async #inspectBackups() {
        this.controller?.abort();
        this.controller = new AbortController();
        const signal = this.controller.signal;
        this.#setBusy(true);
        try {
            this.progress.textContent = '正在读取现有聊天标识…';
            const items = Array.from(this.items.values()).filter(item => item.element?.isConnected);
            const { orphan, uncertain } = await inspectDataMaidBackups({
                api: this.api,
                token: this.token,
                items,
                signal,
                onState: item => this.#renderState(item),
                onProgress: (done, total) => {
                    this.progress.textContent = `正在检查备份 · ${done} / ${total}`;
                },
            });
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

    /**
     * 渲染备份匹配状态
     * @param {object} item 备份增强条目
     */
    #renderState(item) {
        item.badge.textContent = BACKUP_STATE_LABELS[item.state] ?? '待确认';
        item.badge.dataset.state = item.state;
    }

    #applyFilter() {
        const query = this.search?.value.trim().toLowerCase() ?? '';
        for (const item of this.items.values()) {
            const stateVisible = backupStateMatchesFilter(item.state, this.filter);
            const queryVisible = !query || `${item.record.name} ${item.state}`.toLowerCase().includes(query);
            const visible = stateVisible && queryVisible;
            item.element?.classList.toggle('cm-hidden', !visible);
            this.selection.setVisible(item, visible);
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
        this.selection.sync();
    }

    /**
     * 显示备份删除确认
     * @param {object[]} items 待删除备份
     */
    #showDelete(items) {
        const unique = Array.from(new Map(items.map(item => [item.record.hash, item])).values());
        if (!unique.length) return;
        this.pendingDelete = unique;
        this.deleteList.replaceChildren(...unique.map(item => {
            const row = this.deleteTemplate.content.firstElementChild.cloneNode(true);
            row.querySelector('[data-cm-delete-name]').textContent = item.record.name;
            row.querySelector('[data-cm-delete-facts]').textContent = [
                formatBytes(Number(item.record.size ?? 0)),
                formatDataMaidDate(item.record.mtime),
            ].join(' · ');
            row.querySelector('[data-cm-delete-state]').textContent = BACKUP_STATE_LABELS[item.state] ?? '待确认';
            return row;
        }));
        const bytes = unique.reduce((sum, item) => sum + Number(item.record.size ?? 0), 0);
        this.deleteSummary.textContent = `${unique.length} 个聊天备份 · ${formatBytes(bytes)}`;
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
                this.selection.remove(item);
            }
            this.pendingDelete = [];
            this.#closeDelete(true);
            this.selection.sync();
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
        const bytes = records.reduce((sum, item) => sum + Number(item.record.size ?? 0), 0);
        if (info[1]) info[1].lastChild.textContent = ` ${formatBytes(bytes)}`;
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
        this.selection.sync();
    }

    #watchSession() {
        this.sessionObserver?.disconnect();
        this.sessionObserver = new MutationObserver(() => {
            if (this.container?.isConnected) return;
            this.#resetSession();
        });
        this.sessionObserver.observe(document.body, { childList: true, subtree: true });
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
        this.viewer.close();
        this.#closeDelete(true);
        this.selection.reset();
        this.category?.classList.remove('cm-data-maid-enhanced', 'cm-data-maid-busy', 'cm-data-maid-selection-mode');
        this.category?.querySelector('.cm-data-maid-tools')?.remove();
        for (const controls of this.category?.querySelectorAll('.cm-data-maid-controls') ?? []) controls.remove();
        const nativeViews = this.category?.querySelectorAll('.dataMaidItemView') ?? [];
        for (const view of nativeViews) view.classList.remove('cm-hidden');
        this.items.clear();
        this.token = '';
        this.reportItems = [];
        this.busy = false;
        this.category = null;
        this.container = null;
    }
}
