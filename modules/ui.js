import { chatKey, formatBytes, parseBytes, stripJsonl } from './utils.js';
import { deriveIncrementalSplit, filterChatRecords, getCurrentOwner, groupOwnerRecords, groupSplitRecords, sortChatRecords } from './grouping.js';
import { BackupDialogs } from './ui/backup-dialogs.js';
import { SplitDialogs } from './ui/split-dialogs.js';
import { UiTemplates } from './ui/templates.js';

const SORT_ORDERS = ['newest', 'oldest', 'largest', 'messages', 'name'];
const PAGE_SIZES = [20, 50, 100];

function notify(type, message) {
    if (globalThis.toastr?.[type]) globalThis.toastr[type](message);
    else console[type === 'error' ? 'error' : 'log'](message);
}

export class ChatManagerUi {
    /**
     * @param {object} dependencies 依赖项
     * @param {()=>any} dependencies.getContext 上下文提供器
     * @param {import('./api.js').ChatManagerApi} dependencies.api 酒馆接口
     * @param {import('./backups.js').BackupService} dependencies.backups 备份服务
     * @param {import('./splitter.js').SplitService} dependencies.splitter 分割服务
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
     * @param {{groupOwners?:boolean,groupSplits?:boolean,sortOrder?:string,pageSize?:number}} dependencies.viewOptions 列表显示设置
     * @param {(options:{groupOwners:boolean,groupSplits:boolean,sortOrder:string,pageSize:number})=>void} dependencies.onViewOptionsChange 列表显示设置回调
     */
    constructor({ getContext, api, backups, splitter, isGenerating, openRecord, deleteRecord, renameRecord, refreshRecentChats, restoreBackup, openDataMaid, template, dialogTemplates, componentTemplates, getAvatarUrl, viewOptions = {}, onViewOptionsChange = () => {} }) {
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
        this.openingKey = null;
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
        this.pageSize = PAGE_SIZES.includes(Number(viewOptions.pageSize)) ? Number(viewOptions.pageSize) : 50;
        this.expandedOwners = new Set();
        this.expandedSplits = new Set();
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
        this.batchConfirmButton.addEventListener('click', () => this.#confirmDelete(Array.from(this.selectedRecords.values())));
        this.search.addEventListener('input', () => { this.page = 0; this.#filter(); });
        this.sort.addEventListener('change', () => {
            this.sortOrder = this.sort.value;
            this.page = 0;
            this.#filter();
            this.#saveViewOptions();
        });
        this.pageSizeSelect.addEventListener('change', () => {
            this.pageSize = PAGE_SIZES.includes(Number(this.pageSizeSelect.value))
                ? Number(this.pageSizeSelect.value)
                : 50;
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
     * @returns {{version:HTMLElement,button:HTMLButtonElement}} 更新视图
     */
    getExtensionUpdateView() {
        return { version: this.version, button: this.updateButton };
    }

    async open() {
        this.#useDefaultScope();
        this.root.classList.remove('cm-hidden');
        // 生成期间保留上一次稳定快照，结束事件会立即安排同步
        if (!this.records || !this.isGenerating()) await this.refresh();
        else this.#filter();
        this.updateRuntimeState();
    }

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

    /** @param {boolean} loading 聊天清单是否正在加载 */
    #setLoading(loading) {
        if (this.loading === loading) return;
        this.loading = loading;
        this.refreshButton.disabled = loading;
        this.#syncSelectionControls();
        this.#render();
        if (loading) this.#setState('正在同步聊天文件…');
    }

    updateRuntimeState() {
        const generating = this.isGenerating();
        this.#setState(generating
            ? '聊天正在生成：当前仅允许浏览'
            : this.splitter.running ? '分割任务正在执行' : '');
        this.splitDialogs.updateRuntimeState();
        this.#syncSelectionControls();
        this.#render();
    }

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

    /** @returns {string} 当前清单范围的稳定键 */
    #inventoryKey() {
        return this.scope === 'current' && this.currentOwner
            ? `current:${this.currentOwner.ownerType}:${this.currentOwner.ownerId}`
            : 'all';
    }

    /**
     * @param {{key:string,scope:'current'|'all',owner:object|null}} target 清单读取目标
     * @returns {Promise<void>}
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

    /** 根据酒馆当前上下文选择打开面板时的默认显示范围 */
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

    /** 同步互斥的聊天范围选项 */
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
        for (const unit of pageUnits) this.list.append(this.#renderUnit(unit));
        if (!pageUnits.length && !this.loading) this.list.append(this.ui.state('没有可显示的聊天', { empty: true }));
        const grouped = this.groupOwners || this.groupSplits ? ` · ${units.length} 组/项` : '';
        this.pageLabel.textContent = `第 ${this.page + 1} / ${totalPages} 页 · ${this.filtered.length} 条${grouped}`;
        this.previous.disabled = this.page <= 0;
        this.next.disabled = this.page >= totalPages - 1;
    }

    #renderUnit(unit) {
        if (unit.type === 'owner-group') return this.#ownerGroup(unit);
        if (unit.type === 'split-group') return this.#splitGroup(unit);
        return this.#chatRow(unit.record);
    }

    /** @param {'owners'|'splits'} type 要切换的分组维度 */
    #toggleGrouping(type) {
        if (type === 'owners') this.groupOwners = !this.groupOwners;
        if (type === 'splits') this.groupSplits = !this.groupSplits;
        this.page = 0;
        this.#syncGroupingButtons();
        this.#render();
        this.#saveViewOptions();
    }

    /** 保存列表显示设置 */
    #saveViewOptions() {
        this.onViewOptionsChange({
            groupOwners: this.groupOwners,
            groupSplits: this.groupSplits,
            sortOrder: this.sortOrder,
            pageSize: this.pageSize,
        });
    }

    /** 同步分组按钮的可访问状态与视觉状态 */
    #syncGroupingButtons() {
        for (const [button, active] of [[this.groupOwnersButton, this.groupOwners], [this.groupSplitsButton, this.groupSplits]]) {
            button.setAttribute('aria-checked', String(active));
            button.classList.toggle('active', active);
            button.disabled = this.selectionMode;
        }
    }

    /** @param {boolean} enabled 是否进入批量选择模式 */
    #setSelectionMode(enabled) {
        if (enabled && (this.isGenerating() || this.splitter.running)) return;
        this.selectionMode = enabled;
        if (!enabled) this.selectedRecords.clear();
        this.page = 0;
        this.#syncGroupingButtons();
        this.#syncSelectionControls();
        this.#render();
    }

    /** 清除当前勾选，但保留批量选择模式 */
    #clearSelection() {
        this.selectedRecords.clear();
        this.#syncSelectionControls();
        this.#render();
    }

    /** 同步批量删除按钮和面板选择状态 */
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
     * 创建角色或群组的折叠显示单元
     * @param {object} group 所有者分组
     * @returns {HTMLElement} 分组节点
     */
    #ownerGroup(group) {
        const root = this.ui.component('owner-group');
        this.#configureGroupSelection(
            this.ui.mount(root, '[data-cm-owner-select-wrap]'),
            this.ui.mount(root, '[data-cm-owner-select]', HTMLInputElement),
            group.allRecords ?? group.records,
        );
        const image = this.ui.mount(root, '[data-cm-owner-avatar]', HTMLImageElement);
        const toggle = this.ui.mount(root, '[data-cm-owner-toggle]', HTMLButtonElement);
        const children = this.ui.mount(root, '[data-cm-owner-children]');
        const expanded = this.expandedOwners.has(group.key);
        image.src = group.avatarUrl;
        image.alt = group.ownerName;
        this.ui.mount(root, '[data-cm-owner-name]').textContent = group.ownerName;
        const splitCount = group.splitGroupCount ?? group.children.filter(child => child.type === 'split-group').length;
        const ownerRecords = group.allRecords ?? group.records;
        const aggregate = this.#recordAggregate(ownerRecords);
        const summary = `${ownerRecords.length} 条聊天${splitCount ? ` · ${splitCount} 个分卷组` : ''} · 文件合计 ${aggregate.messageCount} 层 / ${formatBytes(aggregate.bytes)}`;
        const latest = aggregate.latest
            ? `最近：${aggregate.latest.fileId} · ${this.ui.formatDate(aggregate.latest.lastMessageAt)}`
            : '没有可用的聊天记录';
        const summaryNode = this.ui.mount(root, '[data-cm-owner-summary]');
        const latestNode = this.ui.mount(root, '[data-cm-owner-latest]');
        summaryNode.textContent = summary;
        summaryNode.title = summary;
        latestNode.textContent = latest;
        latestNode.title = latest;
        this.#configureGroupToggle(toggle, expanded, '聊天', () => {
            expanded ? this.expandedOwners.delete(group.key) : this.expandedOwners.add(group.key);
            this.#render();
        });
        if (expanded) {
            children.classList.remove('cm-hidden');
            group.children.forEach(child => children.append(this.#renderUnit(child)));
        }
        return root;
    }

    /**
     * 创建分卷组显示单元并连接增量分卷入口
     * @param {object} group 分卷组
     * @returns {HTMLElement} 分组节点
     */
    #splitGroup(group) {
        const root = this.ui.component('split-group');
        const splitRecords = group.allRecords ?? group.records;
        const selectableRecords = group.sourceRecord
            ? [group.sourceRecord, ...splitRecords.map(item => item.record)]
            : splitRecords.map(item => item.record);
        this.#configureGroupSelection(
            this.ui.mount(root, '[data-cm-split-select-wrap]'),
            this.ui.mount(root, '[data-cm-split-select]', HTMLInputElement),
            selectableRecords,
        );
        const toggle = this.ui.mount(root, '[data-cm-split-toggle]', HTMLButtonElement);
        const children = this.ui.mount(root, '[data-cm-split-children]');
        const continueButton = this.ui.mount(root, '[data-cm-split-continue]', HTMLButtonElement);
        const incremental = deriveIncrementalSplit(group);
        const expanded = this.expandedSplits.has(group.key);
        const first = splitRecords[0].split;
        const last = splitRecords.at(-1).split;
        const aggregate = this.#recordAggregate(splitRecords.map(item => item.record));
        this.ui.mount(root, '[data-cm-split-group-name]').textContent = group.rootChatId;
        const summary = `${splitRecords.length} 个分卷 · 覆盖 #${first.start}–#${last.end} · 分卷合计 ${aggregate.messageCount} 层 / ${formatBytes(aggregate.bytes)} · ${group.sourceRecord ? '源聊天存在' : '仅保留分卷'}`;
        const latest = aggregate.latest
            ? `最近：${aggregate.latest.fileId} · ${this.ui.formatDate(aggregate.latest.lastMessageAt)}`
            : '没有可用的分卷记录';
        const summaryNode = this.ui.mount(root, '[data-cm-split-group-summary]');
        const latestNode = this.ui.mount(root, '[data-cm-split-group-latest]');
        const incrementalNode = this.ui.mount(root, '[data-cm-split-group-incremental]');
        summaryNode.textContent = summary;
        summaryNode.title = summary;
        latestNode.textContent = latest;
        latestNode.title = latest;
        incrementalNode.textContent = `增量：${incremental.reason}`;
        incrementalNode.title = incrementalNode.textContent;
        continueButton.disabled = !incremental.available || this.isGenerating() || this.splitter.running;
        continueButton.title = incremental.available ? incremental.reason : `暂不可增量分卷：${incremental.reason}`;
        this.ui.bindButton(continueButton, () => this.openSplit(incremental.sourceRecord, incremental.options));
        this.#configureGroupToggle(toggle, expanded, '分卷', () => {
            expanded ? this.expandedSplits.delete(group.key) : this.expandedSplits.add(group.key);
            this.#render();
        });
        if (expanded) {
            children.classList.remove('cm-hidden');
            if (group.sourceRecord) children.append(this.#chatRow(group.sourceRecord, { source: true }));
            group.records.forEach(item => children.append(this.#chatRow(item.record)));
        }
        return root;
    }

    /**
     * 将组复选框绑定到组内全部实际聊天文件，并同步全选和半选状态
     * @param {HTMLElement} wrap 复选框容器
     * @param {HTMLInputElement} input 组复选框
     * @param {object[]} records 组内聊天记录
     */
    #configureGroupSelection(wrap, input, records) {
        const unique = Array.from(new Map(records.map(record => [chatKey(record), record])).values());
        const selectedCount = unique.filter(record => this.selectedRecords.has(chatKey(record))).length;
        wrap.classList.toggle('cm-hidden', !this.selectionMode);
        input.checked = unique.length > 0 && selectedCount === unique.length;
        input.indeterminate = selectedCount > 0 && selectedCount < unique.length;
        wrap.closest('.cm-record-group')?.classList.toggle('cm-selected', selectedCount > 0);
        input.addEventListener('change', () => {
            for (const record of unique) {
                const key = chatKey(record);
                if (input.checked) this.selectedRecords.set(key, record);
                else this.selectedRecords.delete(key);
            }
            this.#syncSelectionControls();
            this.#render();
        });
    }

    /**
     * 汇总一组聊天文件的规模与最近记录
     * @param {object[]} records 聊天记录
     * @returns {{messageCount:number,bytes:number,latest:object|null}} 聚合信息
     */
    #recordAggregate(records) {
        let messageCount = 0;
        let bytes = 0;
        let latest = null;
        let latestTime = Number.NEGATIVE_INFINITY;
        for (const record of records) {
            messageCount += Number(record.messageCount) || 0;
            bytes += parseBytes(record.fileSize);
            const time = new Date(record.lastMessageAt).valueOf();
            if (Number.isFinite(time) && time > latestTime) {
                latest = record;
                latestTime = time;
            }
        }
        return { messageCount, bytes, latest };
    }

    /**
     * 配置折叠按钮并保持图标和无障碍提示一致
     * @param {HTMLButtonElement} button 按钮
     * @param {boolean} expanded 是否展开
     * @param {string} label 折叠内容名称
     * @param {()=>void} handler 点击处理
     */
    #configureGroupToggle(button, expanded, label, handler) {
        const action = expanded ? '收起' : '展开';
        button.setAttribute('aria-expanded', String(expanded));
        button.setAttribute('aria-label', `${action}${label}`);
        button.title = `${action}${label}`;
        this.ui.mount(button, '[data-cm-group-chevron]').classList.toggle('fa-chevron-up', expanded);
        this.ui.mount(button, '[data-cm-group-chevron]').classList.toggle('fa-chevron-down', !expanded);
        this.ui.bindButton(button, handler);
    }

    #chatRow(record, { source = false } = {}) {
        const row = this.ui.component('chat-row');
        const selectWrap = this.ui.mount(row, '[data-cm-chat-select-wrap]');
        const select = this.ui.mount(row, '[data-cm-chat-select]', HTMLInputElement);
        const image = this.ui.mount(row, '[data-cm-chat-avatar]', HTMLImageElement);
        const name = this.ui.mount(row, '[data-cm-chat-name]');
        const owner = this.ui.mount(row, '[data-cm-chat-owner]');
        const file = this.ui.mount(row, '[data-cm-chat-file]');
        const sourceBadge = this.ui.mount(row, '[data-cm-chat-source]');
        const date = this.ui.mount(row, '[data-cm-chat-date]', HTMLTimeElement);
        const preview = this.ui.mount(row, '[data-cm-chat-preview]');
        const countWrap = this.ui.mount(row, '[data-cm-chat-count-wrap]');
        const count = this.ui.mount(row, '[data-cm-chat-count]');
        const size = this.ui.mount(row, '[data-cm-chat-size]');
        const open = this.ui.mount(row, '[data-cm-chat-open]', HTMLButtonElement);
        const view = this.ui.mount(row, '[data-cm-chat-view]', HTMLButtonElement);
        const rename = this.ui.mount(row, '[data-cm-chat-rename]', HTMLButtonElement);
        const backup = this.ui.mount(row, '[data-cm-chat-backups]', HTMLButtonElement);
        const split = this.ui.mount(row, '[data-cm-chat-split]', HTMLButtonElement);
        const remove = this.ui.mount(row, '[data-cm-chat-delete]', HTMLButtonElement);
        const key = chatKey(record);
        selectWrap.classList.toggle('cm-hidden', !this.selectionMode);
        select.checked = this.selectedRecords.has(key);
        row.classList.toggle('cm-source-record', source);
        sourceBadge.classList.toggle('cm-hidden', !source);
        image.src = record.avatarUrl;
        image.alt = record.ownerName;
        name.title = `${record.ownerName} - ${record.fileId}`;
        owner.textContent = record.ownerName;
        file.textContent = record.fileId;
        date.textContent = this.ui.formatDate(record.lastMessageAt);
        preview.textContent = record.preview;
        preview.title = record.preview;
        countWrap.title = `${record.messageCount} 层消息`;
        count.textContent = String(record.messageCount);
        size.textContent = record.fileSize;
        const openRecord = async () => {
            if (this.openingKey) return;
            this.openingKey = key;
            row.classList.add('cm-opening');
            open.disabled = true;
            try {
                await this.openRecord(record);
                this.close();
            } finally {
                this.openingKey = null;
                row.classList.remove('cm-opening');
                open.disabled = this.isGenerating() || this.splitter.running;
            }
        };
        this.ui.bindButton(open, openRecord);
        this.ui.bindButton(view, () => this.backupDialogs.viewChat(record));
        this.ui.bindButton(rename, async () => {
            try {
                if (await this.renameRecord(record)) {
                    await this.refresh();
                    notify('success', '聊天已重命名');
                }
            } catch (error) {
                notify('error', error.message);
            }
        });
        this.ui.bindButton(backup, () => this.openBackups(record));
        this.ui.bindButton(split, () => this.openSplit(record));
        this.ui.bindButton(remove, () => this.#confirmDelete([record]));
        open.disabled = this.isGenerating() || this.splitter.running;
        view.disabled = this.loading || this.isGenerating() || this.splitter.running;
        rename.disabled = this.loading || this.isGenerating() || this.splitter.running;
        backup.disabled = this.isGenerating() || this.splitter.running;
        split.disabled = this.isGenerating() || this.splitter.running || record.messageCount < 1;
        remove.disabled = this.loading || this.isGenerating() || this.splitter.running;

        select.addEventListener('change', () => {
            if (select.checked) this.selectedRecords.set(key, record);
            else this.selectedRecords.delete(key);
            row.classList.toggle('cm-selected', select.checked);
            this.#syncSelectionControls();
            this.#render();
        });
        row.classList.toggle('cm-selected', select.checked);

        row.addEventListener('click', event => {
            if (event.target.closest('button, label')) return;
            if (!this.selectionMode) return;
            select.checked = !select.checked;
            select.dispatchEvent(new Event('change'));
        });
        return row;
    }

    /**
     * 显示删除清单，并在确认后串行调用酒馆原生删除链路
     * @param {object[]} records 待删除聊天
     * @returns {Promise<void>}
     */
    async #confirmDelete(records) {
        if (!records.length) return;
        if (this.loading) return notify('warning', '聊天清单正在读取，完成后才能删除聊天');
        if (this.isGenerating()) return notify('warning', '聊天正在生成，结束后才能删除聊天');
        if (this.splitter.running) return notify('warning', '分割任务正在写入聊天，完成后才能删除聊天');
        const unique = Array.from(new Map(records.map(record => [chatKey(record), record])).values());
        const dialog = this.ui.dialog([
            unique.length === 1 ? '删除聊天' : '批量删除聊天',
            unique.length === 1 ? unique[0].ownerName : `已选择 ${unique.length} 条聊天`,
            unique.length === 1 ? unique[0].fileId : '确认后将按列表顺序逐条删除',
        ], 'delete-chats');
        const summary = this.ui.mount(dialog.body, '[data-cm-delete-summary]');
        const list = this.ui.mount(dialog.body, '[data-cm-delete-list]');
        const cancel = this.ui.mount(dialog.body, '[data-cm-delete-cancel]', HTMLButtonElement);
        const confirm = this.ui.mount(dialog.body, '[data-cm-delete-confirm]', HTMLButtonElement);
        const confirmText = this.ui.mount(dialog.body, '[data-cm-delete-confirm-text]');
        const aggregate = this.#recordAggregate(unique);
        const rows = new Map();
        summary.textContent = `${unique.length} 个聊天文件 · 合计 ${aggregate.messageCount} 层 / ${formatBytes(aggregate.bytes)}`;
        confirmText.textContent = unique.length === 1 ? '确认删除' : `确认删除 ${unique.length} 条`;
        for (const record of unique) {
            const row = this.ui.component('delete-target');
            this.ui.mount(row, '[data-cm-delete-owner]').textContent = record.ownerName;
            this.ui.mount(row, '[data-cm-delete-file]').textContent = record.fileId;
            this.ui.mount(row, '[data-cm-delete-facts]').textContent = `${record.messageCount} 层 · ${record.fileSize}`;
            rows.set(chatKey(record), row);
            list.append(row);
        }
        this.ui.bindButton(cancel, () => dialog.close());
        this.ui.bindButton(confirm, async () => {
            confirm.disabled = true;
            cancel.disabled = true;
            dialog.setClosable(false);
            let succeeded = 0;
            let failed = 0;
            for (const record of unique) {
                const row = rows.get(chatKey(record));
                const status = this.ui.mount(row, '[data-cm-delete-status]');
                status.textContent = '正在删除';
                status.dataset.state = 'loading';
                try {
                    await this.deleteRecord(record);
                    if (await this.api.chatExists(record)) throw new Error('酒馆原生删除链路未删除该文件');
                    succeeded++;
                    status.textContent = '已删除';
                    status.dataset.state = 'ready';
                } catch (error) {
                    failed++;
                    status.textContent = '删除失败';
                    status.dataset.state = 'error';
                    row.title = error.message;
                }
                summary.textContent = `正在处理 ${succeeded + failed} / ${unique.length} · 已删除 ${succeeded} 条${failed ? ` · 失败 ${failed} 条` : ''}`;
            }
            dialog.setClosable(true);
            cancel.disabled = false;
            cancel.textContent = '关闭';
            confirm.classList.add('cm-hidden');
            summary.textContent = `处理完成 · 已删除 ${succeeded} 条${failed ? ` · 失败 ${failed} 条` : ''}`;
            this.#setSelectionMode(false);
            if (succeeded > 0) {
                try {
                    await this.refreshRecentChats();
                } catch (error) {
                    console.warn('[聊天文件管理] 刷新最近聊天失败', error);
                }
            }
            await this.refresh();
            notify(failed ? 'warning' : 'success', failed ? `已删除 ${succeeded} 条，${failed} 条失败` : `已删除 ${succeeded} 条聊天`);
        });
    }

    /** @param {object} record 原聊天记录 */
    openBackups(record) {
        return this.backupDialogs.open(record);
    }

    /**
     * @param {object} record 来源聊天
     * @param {object} initialOptions 分卷初始配置
     */
    openSplit(record, initialOptions = {}) {
        return this.splitDialogs.open(record, initialOptions);
    }

    /** @param {object[]} tasks 未完成分卷任务 */
    showRecovery(tasks) {
        return this.splitDialogs.showRecovery(tasks);
    }
}
