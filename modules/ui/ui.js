import { chatKey, stripJsonl } from '../shared/utils.js';
import {
    filterChatRecords,
    getCurrentOwner,
    groupOwnerRecords,
    groupSplitRecords,
    sortChatRecords,
} from '../chat/grouping.js';
import { BackupDialogs } from './backup-dialogs.js';
import { ChatDeleteDialog } from './chat-delete-dialog.js';
import { ChatListRenderer } from './chat-list-renderer.js';
import { SplitDialogs } from './split-dialogs.js';
import { UiTemplates } from './templates.js';

const SORT_ORDERS = ['newest', 'oldest', 'largest', 'messages', 'name'];
const DEFAULT_PAGE_SIZE = 50;

/**
 * 规范化分页数量
 * @param {unknown} value 分页数量
 * @returns {number} 有效分页数量
 */
function normalizePageSize(value) {
    const size = Number(value);
    return Number.isInteger(size) && size > 0 ? size : DEFAULT_PAGE_SIZE;
}

function notify(type, message) {
    if (globalThis.toastr?.[type]) globalThis.toastr[type](message);
    else console[type === 'error' ? 'error' : 'log'](message);
}

export class ChatManagerUi {
    /**
     * @param {object} dependencies 依赖项
     * @param {()=>any} dependencies.getContext 上下文提供器
     * @param {import('../platform/api.js').ChatManagerApi} dependencies.api 酒馆接口
     * @param {import('../backups/backups.js').BackupService} dependencies.backups 备份服务
     * @param {import('../chat/splitter.js').SplitService} dependencies.splitter 分割服务
     * @param {()=>boolean} dependencies.isGenerating 是否正在生成
     * @param {(record:object)=>Promise<void>} dependencies.openRecord 打开聊天回调
     * @param {(record:object)=>Promise<void>} dependencies.deleteRecord 删除聊天回调
     * @param {(record:object)=>Promise<boolean>} dependencies.renameRecord 重命名聊天回调
     * @param {()=>Promise<void>} dependencies.refreshRecentChats 刷新酒馆最近聊天回调
     * @param {(record:object,backup:object)=>Promise<string[]>} dependencies.restoreBackup 原生备份恢复回调
     * @param {()=>Promise<void>} dependencies.openDataMaid 打开酒馆原生数据清理面板
     * @param {string} dependencies.template 稳定面板模板
     * @param {string} dependencies.dialogTemplates 弹窗模板注册表
     * @param {string} dependencies.componentTemplates 重复内容组件模板注册表
     * @param {(record:object)=>string} dependencies.getAvatarUrl 头像地址生成器
     * @param {object} dependencies.viewOptions 列表显示设置
     * @param {(options:object)=>void} dependencies.onViewOptionsChange 设置保存回调
     */
    constructor({
        getContext,
        api,
        backups,
        splitter,
        isGenerating,
        openRecord,
        deleteRecord,
        renameRecord,
        refreshRecentChats,
        restoreBackup,
        openDataMaid,
        template,
        dialogTemplates,
        componentTemplates,
        getAvatarUrl,
        viewOptions = {},
        onViewOptionsChange = () => {},
    }) {
        this.getContext = getContext;
        this.api = api;
        this.backups = backups;
        this.splitter = splitter;
        this.isGenerating = isGenerating;
        this.openRecord = openRecord;
        this.deleteRecord = deleteRecord;
        this.renameRecord = renameRecord;
        this.refreshRecentChats = refreshRecentChats;
        this.restoreBackup = restoreBackup;
        this.openDataMaid = openDataMaid;
        this.getAvatarUrl = getAvatarUrl;
        this.records = null;
        this.filtered = [];
        this.page = 0;
        this.scope = 'all';
        this.currentOwner = null;
        this.selectionMode = false;
        this.selectedRecords = new Map();
        this.loading = false;
        this.refreshTask = null;
        this.refreshKey = '';
        this.refreshTimer = null;
        this.groupOwners = Boolean(viewOptions.groupOwners);
        this.groupSplits = Boolean(viewOptions.groupSplits);
        this.sortOrder = SORT_ORDERS.includes(viewOptions.sortOrder)
            ? viewOptions.sortOrder
            : 'newest';
        this.pageSize = normalizePageSize(viewOptions.pageSize);
        this.onViewOptionsChange = onViewOptionsChange;
        this.#build(template, dialogTemplates, componentTemplates);
    }

    #build(template, dialogTemplates, componentTemplates) {
        this.ui = new UiTemplates(dialogTemplates, componentTemplates, notify);
        const root = this.ui.root(template, '聊天管理面板');
        const required = this.ui.mount.bind(this.ui);

        this.root = root;
        this.search = required(root, '[data-cm-search]', HTMLInputElement);
        this.sort = required(root, '[data-cm-sort]', HTMLSelectElement);
        this.sort.value = this.sortOrder;
        this.pageSizeSelect = required(root, '[data-cm-page-size]', HTMLSelectElement);
        if (!Array.from(this.pageSizeSelect.options).some(option => Number(option.value) === this.pageSize)) {
            this.pageSizeSelect.add(new Option(`${this.pageSize} / 页`, String(this.pageSize)));
        }
        this.pageSizeSelect.value = String(this.pageSize);
        this.state = required(root, '[data-cm-state]');
        this.list = required(root, '[data-cm-list]');
        this.previous = required(root, '[data-cm-previous]', HTMLButtonElement);
        this.next = required(root, '[data-cm-next]', HTMLButtonElement);
        this.pageLabel = required(root, '[data-cm-page]');
        this.version = required(root, '[data-cm-version]');
        this.updateButton = required(root, '[data-cm-update]', HTMLButtonElement);
        this.scopeCurrentButton = required(root, '[data-cm-scope-current]', HTMLButtonElement);
        this.scopeCurrentLabel = required(root, '[data-cm-scope-current-label]');
        this.scopeAllButton = required(root, '[data-cm-scope-all]', HTMLButtonElement);
        this.groupOwnersButton = required(root, '[data-cm-group-owners]', HTMLButtonElement);
        this.groupSplitsButton = required(root, '[data-cm-group-splits]', HTMLButtonElement);
        this.batchStartButton = required(root, '[data-cm-batch-start]', HTMLButtonElement);
        this.selectionToolbar = required(root, '[data-cm-selection-toolbar]');
        this.batchCancelButton = required(root, '[data-cm-batch-cancel]', HTMLButtonElement);
        this.batchConfirmButton = required(root, '[data-cm-batch-confirm]', HTMLButtonElement);
        this.batchCount = required(root, '[data-cm-batch-count]');
        this.backupDialogs = new BackupDialogs({
            ui: this.ui,
            api: this.api,
            backups: this.backups,
            isGenerating: this.isGenerating,
            isSplitting: () => this.splitter.running,
            restoreBackup: this.restoreBackup,
            closePanel: () => this.close(),
            notify,
        });
        this.splitDialogs = new SplitDialogs({
            ui: this.ui,
            splitter: this.splitter,
            isGenerating: this.isGenerating,
            refresh: () => this.refresh(),
            notify,
        });
        this.deleteDialog = new ChatDeleteDialog({
            ui: this.ui,
            api: this.api,
            deleteRecord: this.deleteRecord,
            refreshRecentChats: this.refreshRecentChats,
            refresh: () => this.refresh(),
            resetSelection: () => this.#setSelectionMode(false),
            isLoading: () => this.loading,
            isGenerating: this.isGenerating,
            isSplitting: () => this.splitter.running,
            notify,
        });
        this.listRenderer = new ChatListRenderer({
            ui: this.ui,
            selectedRecords: this.selectedRecords,
            isSelectionMode: () => this.selectionMode,
            isLoading: () => this.loading,
            isGenerating: this.isGenerating,
            isSplitting: () => this.splitter.running,
            render: () => this.#render(),
            syncSelection: () => this.#syncSelectionControls(),
            closePanel: () => this.close(),
            openRecord: this.openRecord,
            viewRecord: record => this.backupDialogs.viewChat(record),
            renameRecord: this.renameRecord,
            openBackups: record => this.openBackups(record),
            openSplit: (record, options) => this.openSplit(record, options),
            confirmDelete: records => this.deleteDialog.open(records),
            refresh: () => this.refresh(),
            notify,
        });

        required(root, '[data-cm-close]', HTMLButtonElement).addEventListener('click', () => this.close());
        this.refreshButton = required(root, '[data-cm-refresh]', HTMLButtonElement);
        this.refreshButton.addEventListener('click', () => this.refresh());
        required(root, '[data-cm-data-maid-open]', HTMLButtonElement).addEventListener('click', () => void this.openDataMaid());
        this.scopeCurrentButton.addEventListener('click', () => void this.#setScope('current'));
        this.scopeAllButton.addEventListener('click', () => void this.#setScope('all'));
        this.groupOwnersButton.addEventListener('click', () => this.#toggleGrouping('owners'));
        this.groupSplitsButton.addEventListener('click', () => this.#toggleGrouping('splits'));
        this.batchStartButton.addEventListener('click', () => this.#setSelectionMode(!this.selectionMode));
        this.batchCancelButton.addEventListener('click', () => this.#clearSelection());
        this.batchConfirmButton.addEventListener('click', () => (
            this.deleteDialog.open(Array.from(this.selectedRecords.values()))
        ));
        this.search.addEventListener('input', () => { this.page = 0; this.#filter(); });
        this.sort.addEventListener('change', () => {
            this.sortOrder = this.sort.value;
            this.page = 0;
            this.#filter();
            this.#saveViewOptions();
        });
        this.pageSizeSelect.addEventListener('change', () => {
            this.pageSize = normalizePageSize(this.pageSizeSelect.value);
            this.page = 0;
            this.#render();
            this.#saveViewOptions();
        });
        this.previous.addEventListener('click', () => { this.page--; this.#render(); });
        this.next.addEventListener('click', () => { this.page++; this.#render(); });
        this.#syncGroupingButtons();
        this.#syncScopeButtons();
        this.#syncSelectionControls();
        document.body.append(this.root);
    }

    /**
     * 返回主面板中的版本与更新控件
     * @returns {object} 版本文本和更新按钮
     */
    getExtensionUpdateView() {
        return { version: this.version, button: this.updateButton };
    }

    /**
     * 打开聊天管理面板并同步当前范围的聊天文件
     * @returns {Promise<void>} 面板打开完成
     */
    async open() {
        this.#useDefaultScope();
        this.root.classList.remove('cm-hidden');
        // 生成期间保留上一次稳定快照，结束事件会立即安排同步
        if (!this.records || !this.isGenerating()) await this.refresh();
        else this.#filter();
        this.updateRuntimeState();
    }

    /**
     * 关闭面板并清理临时批量选择状态
     */
    close() {
        if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
        if (this.selectionMode) this.#setSelectionMode(false);
        this.root.classList.add('cm-hidden');
    }

    /**
     * 标记聊天文件清单已变化，并在面板可见且文件稳定时防抖同步
     * @param {number} delay 防抖等待时间
     */
    invalidateChatFiles(delay = 350) {
        if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
        if (this.root.classList.contains('cm-hidden') || this.isGenerating() || this.splitter.running) return;
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            void this.refresh();
        }, delay);
    }

    #setState(message, error = false) {
        this.state.textContent = message;
        this.state.classList.toggle('cm-hidden', !message);
        this.state.classList.toggle('cm-error', error);
    }

    /**
     * 设置聊天清单加载状态
     * @param {boolean} loading 聊天清单是否正在加载
     */
    #setLoading(loading) {
        if (this.loading === loading) return;
        this.loading = loading;
        this.refreshButton.disabled = loading;
        this.#syncSelectionControls();
        this.#render();
        if (loading) this.#setState('正在同步聊天文件…');
    }

    /**
     * 同步生成、分卷和批量操作的可用状态
     */
    updateRuntimeState() {
        const generating = this.isGenerating();
        this.#setState(generating
            ? '聊天正在生成：当前仅允许浏览'
            : this.splitter.running ? '分割任务正在执行' : '');
        this.splitDialogs.updateRuntimeState();
        this.#syncSelectionControls();
        this.#render();
    }

    /**
     * 读取当前清单范围，同一范围的并发请求会复用现有任务
     * @returns {Promise<void>} 清单刷新完成
     */
    async refresh() {
        const target = {
            key: this.#inventoryKey(),
            scope: this.scope,
            owner: this.currentOwner ? { ...this.currentOwner } : null,
        };
        if (this.refreshTask) {
            if (this.refreshKey === target.key) return this.refreshTask;
            await this.refreshTask;
            return this.refresh();
        }
        this.refreshKey = target.key;
        this.refreshTask = this.#loadChatFiles(target);
        try {
            return await this.refreshTask;
        } finally {
            this.refreshTask = null;
            this.refreshKey = '';
        }
    }

    /**
     * 获取当前清单范围的稳定键
     * @returns {string} 稳定键
     */
    #inventoryKey() {
        return this.scope === 'current' && this.currentOwner
            ? `current:${this.currentOwner.ownerType}:${this.currentOwner.ownerId}`
            : 'all';
    }

    /**
     * 读取指定范围的聊天文件并更新清单
     * @param {object} target 清单读取目标
     * @param {string} target.key 稳定请求键
     * @param {'current'|'all'} target.scope 聊天范围
     * @param {object|null} target.owner 当前所有者
     * @returns {Promise<void>} 清单加载完成
     */
    async #loadChatFiles(target) {
        this.#setLoading(true);
        try {
            const data = target.scope === 'current' && target.owner
                ? await this.api.listOwnerChatFiles(target.owner)
                : await this.api.listChatFiles();
            if (!Array.isArray(data)) throw new Error('聊天文件接口返回格式无效');
            const context = this.getContext();
            const characters = new Map((context.characters ?? []).map(character => [character.avatar, character]));
            const groups = new Map((context.groups ?? []).map(group => [String(group.id), group]));
            const records = data.map(item => {
                const isGroup = item.group !== undefined && item.group !== null;
                const owner = isGroup
                    ? groups.get(String(item.group))
                    : characters.get(item.avatar);
                if (!owner) return null;
                const record = {
                    ownerType: isGroup ? 'group' : 'character',
                    ownerId: String(isGroup ? item.group : item.avatar),
                    ownerName: String(owner.name ?? item.char_name ?? item.group ?? item.avatar),
                    fileId: stripJsonl(item.file_id ?? item.file_name),
                    fileName: String(item.file_name ?? `${item.file_id}.jsonl`),
                    fileSize: String(item.file_size ?? ''),
                    messageCount: Number(item.chat_items ?? 0),
                    lastMessageAt: item.last_mes ?? '',
                    preview: String(item.mes ?? ''),
                    chatManager: item.chat_metadata?.chat_manager ?? null,
                };
                record.avatarUrl = this.getAvatarUrl(record);
                return record;
            }).filter(Boolean).sort((a, b) => new Date(b.lastMessageAt).valueOf() - new Date(a.lastMessageAt).valueOf());
            // 范围切换后，较早返回的请求不能覆盖新范围的清单
            if (target.key !== this.#inventoryKey()) return;
            this.records = records;
            this.page = 0;
            this.#filter();
            this.updateRuntimeState();
        } catch (error) {
            this.#setState(error.message, true);
            notify('error', error.message);
        } finally {
            this.#setLoading(false);
        }
    }

    #filter() {
        this.filtered = sortChatRecords(
            filterChatRecords(this.records ?? [], this.scope, this.currentOwner, this.search.value),
            this.sortOrder,
        );
        this.#render();
    }

    /**
     * 根据酒馆当前上下文选择默认显示范围
     */
    #useDefaultScope() {
        this.currentOwner = getCurrentOwner(this.getContext());
        this.scope = this.currentOwner ? 'current' : 'all';
        this.page = 0;
        this.#syncScopeButtons();
    }

    /**
     * 切换聊天列表的所有者范围
     * @param {'current'|'all'} scope 显示范围
     */
    async #setScope(scope) {
        if (scope === 'current' && !this.currentOwner) return;
        if (scope === this.scope) return;
        this.scope = scope;
        this.page = 0;
        this.#syncScopeButtons();
        await this.refresh();
    }

    /**
     * 同步互斥的聊天范围选项
     */
    #syncScopeButtons() {
        this.scopeCurrentLabel.textContent = this.currentOwner?.label ?? '当前角色';
        this.scopeCurrentButton.disabled = !this.currentOwner;
        for (const [button, active] of [[this.scopeCurrentButton, this.scope === 'current'], [this.scopeAllButton, this.scope === 'all']]) {
            button.setAttribute('aria-checked', String(active));
            button.classList.toggle('active', active);
        }
    }

    #render() {
        if (!this.list) return;
        this.list.replaceChildren();
        const units = this.groupOwners
            ? groupOwnerRecords(this.filtered, this.groupSplits, this.records ?? [])
            : this.groupSplits
                ? groupSplitRecords(this.filtered, this.records ?? [])
                : this.filtered.map(record => ({ type: 'record', key: `record:${chatKey(record)}`, record }));
        const totalPages = Math.max(1, Math.ceil(units.length / this.pageSize));
        this.page = Math.max(0, Math.min(this.page, totalPages - 1));
        const pageUnits = units.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize);
        for (const unit of pageUnits) this.list.append(this.listRenderer.renderUnit(unit));
        if (!pageUnits.length && !this.loading) this.list.append(this.ui.state('没有可显示的聊天', { empty: true }));
        const grouped = this.groupOwners || this.groupSplits ? ` · ${units.length} 组/项` : '';
        this.pageLabel.textContent = `第 ${this.page + 1} / ${totalPages} 页 · ${this.filtered.length} 条${grouped}`;
        this.previous.disabled = this.page <= 0;
        this.next.disabled = this.page >= totalPages - 1;
    }

    /**
     * 切换分组方式
     * @param {'owners'|'splits'} type 分组维度
     */
    #toggleGrouping(type) {
        if (type === 'owners') this.groupOwners = !this.groupOwners;
        if (type === 'splits') this.groupSplits = !this.groupSplits;
        this.page = 0;
        this.#syncGroupingButtons();
        this.#render();
        this.#saveViewOptions();
    }

    /**
     * 保存列表显示设置
     */
    #saveViewOptions() {
        this.onViewOptionsChange({
            groupOwners: this.groupOwners,
            groupSplits: this.groupSplits,
            sortOrder: this.sortOrder,
            pageSize: this.pageSize,
        });
    }

    /**
     * 同步分组按钮状态
     */
    #syncGroupingButtons() {
        for (const [button, active] of [[this.groupOwnersButton, this.groupOwners], [this.groupSplitsButton, this.groupSplits]]) {
            button.setAttribute('aria-checked', String(active));
            button.classList.toggle('active', active);
            button.disabled = this.selectionMode;
        }
    }

    /**
     * 切换批量选择模式
     * @param {boolean} enabled 是否启用
     */
    #setSelectionMode(enabled) {
        if (enabled && (this.isGenerating() || this.splitter.running)) return;
        this.selectionMode = enabled;
        if (!enabled) this.selectedRecords.clear();
        this.page = 0;
        this.#syncGroupingButtons();
        this.#syncSelectionControls();
        this.#render();
    }

    /**
     * 清除当前勾选并保留批量选择模式
     */
    #clearSelection() {
        this.selectedRecords.clear();
        this.#syncSelectionControls();
        this.#render();
    }

    /**
     * 同步批量删除按钮和选择状态
     */
    #syncSelectionControls() {
        const blocked = this.isGenerating() || this.splitter.running || this.loading;
        this.root.classList.toggle('cm-selection-mode', this.selectionMode);
        this.selectionToolbar.classList.toggle('cm-hidden', !this.selectionMode);
        this.batchStartButton.classList.toggle('active', this.selectionMode);
        this.batchStartButton.setAttribute('aria-pressed', String(this.selectionMode));
        const batchAction = this.selectionMode ? '退出批量选择' : '进入批量选择';
        this.batchStartButton.title = batchAction;
        this.batchStartButton.setAttribute('aria-label', batchAction);
        this.batchStartButton.disabled = blocked;
        this.batchCancelButton.disabled = blocked || this.selectedRecords.size === 0;
        this.batchConfirmButton.disabled = blocked || this.selectedRecords.size === 0;
        this.batchCount.textContent = `已选 ${this.selectedRecords.size} 条`;
    }

    /**
     * 打开聊天对应备份
     * @param {object} record 原聊天记录
     * @returns {Promise<void>} 弹窗任务
     */
    /**
     * 打开指定聊天的备份列表
     * @param {object} record 聊天记录
     */
    openBackups(record) {
        return this.backupDialogs.open(record);
    }

    /**
     * @param {object} record 来源聊天
     * @param {object} initialOptions 分卷初始配置
     */
    /**
     * 打开指定聊天的分卷面板
     * @param {object} record 聊天记录
     * @param {object} [initialOptions] 可沿用的分卷配置
     */
    openSplit(record, initialOptions = {}) {
        return this.splitDialogs.open(record, initialOptions);
    }

    /**
     * 显示未完成分卷任务
     * @param {object[]} tasks 未完成任务
     * @returns {Promise<void>} 弹窗任务
     */
    /**
     * 展示可恢复的分卷任务
     * @param {object[]} tasks 待恢复任务
     */
    showRecovery(tasks) {
        return this.splitDialogs.showRecovery(tasks);
    }
}
