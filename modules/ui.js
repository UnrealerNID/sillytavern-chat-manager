import { chatKey, element, formatBytes, stripJsonl } from './utils.js';
import { describePart } from './splitter.js';
import { deriveIncrementalSplit, groupOwnerRecords, groupSplitRecords } from './grouping.js';

const PAGE_SIZE = 50;

function notify(type, message) {
    if (globalThis.toastr?.[type]) globalThis.toastr[type](message);
    else console[type === 'error' ? 'error' : 'log'](message);
}

export class ChatManagerUi {
    /**
     * @param {object} dependencies Dependencies
     * @param {()=>any} dependencies.getContext Context provider
     * @param {import('./api.js').ChatManagerApi} dependencies.api API
     * @param {import('./backups.js').BackupService} dependencies.backups Backup service
     * @param {import('./splitter.js').SplitService} dependencies.splitter Split service
     * @param {()=>boolean} dependencies.isGenerating Generation state
     * @param {(record:object)=>Promise<void>} dependencies.openRecord Open callback
     * @param {(record:object,backup:object)=>Promise<string[]>} dependencies.restoreBackup 原生备份恢复回调
     * @param {string} dependencies.template 稳定面板模板
     * @param {string} dependencies.dialogTemplates 弹窗模板注册表
     * @param {string} dependencies.componentTemplates 重复内容组件模板注册表
     * @param {(record:object)=>string} dependencies.getAvatarUrl 头像地址生成器
     * @param {{groupOwners?:boolean,groupSplits?:boolean}} dependencies.viewOptions 列表分组设置
     * @param {(options:{groupOwners:boolean,groupSplits:boolean})=>void} dependencies.onViewOptionsChange 分组设置回调
     */
    constructor({ getContext, api, backups, splitter, isGenerating, openRecord, restoreBackup, template, dialogTemplates, componentTemplates, getAvatarUrl, viewOptions = {}, onViewOptionsChange = () => {} }) {
        this.getContext = getContext;
        this.api = api;
        this.backups = backups;
        this.splitter = splitter;
        this.isGenerating = isGenerating;
        this.openRecord = openRecord;
        this.restoreBackup = restoreBackup;
        this.getAvatarUrl = getAvatarUrl;
        this.records = null;
        this.filtered = [];
        this.page = 0;
        this.selectedKey = null;
        this.loading = false;
        this.groupOwners = Boolean(viewOptions.groupOwners);
        this.groupSplits = Boolean(viewOptions.groupSplits);
        this.expandedOwners = new Set();
        this.expandedSplits = new Set();
        this.onViewOptionsChange = onViewOptionsChange;
        this.#build(template, dialogTemplates, componentTemplates);
    }

    #build(template, dialogTemplates, componentTemplates) {
        const holder = document.createElement('template');
        holder.innerHTML = template.trim();
        const root = holder.content.firstElementChild;
        if (!(root instanceof HTMLElement)) throw new Error('聊天管理面板模板无效');
        const required = (scope, selector, type = HTMLElement) => {
            const node = scope.querySelector(selector);
            if (!(node instanceof type)) throw new Error(`聊天管理模板缺少 ${selector}`);
            return node;
        };
        const dialogHolder = document.createElement('template');
        dialogHolder.innerHTML = dialogTemplates.trim();
        const dialogRegistry = dialogHolder.content.firstElementChild;
        if (!(dialogRegistry instanceof HTMLElement)) throw new Error('聊天管理弹窗模板无效');
        const componentHolder = document.createElement('template');
        componentHolder.innerHTML = componentTemplates.trim();
        const componentRegistry = componentHolder.content.firstElementChild;
        if (!(componentRegistry instanceof HTMLElement)) throw new Error('聊天管理组件模板无效');

        this.root = root;
        this.search = required(root, '[data-cm-search]', HTMLInputElement);
        this.state = required(root, '[data-cm-state]');
        this.list = required(root, '[data-cm-list]');
        this.previous = required(root, '[data-cm-previous]', HTMLButtonElement);
        this.next = required(root, '[data-cm-next]', HTMLButtonElement);
        this.pageLabel = required(root, '[data-cm-page]');
        this.version = required(root, '[data-cm-version]');
        this.updateButton = required(root, '[data-cm-update]', HTMLButtonElement);
        this.groupOwnersButton = required(root, '[data-cm-group-owners]', HTMLButtonElement);
        this.groupSplitsButton = required(root, '[data-cm-group-splits]', HTMLButtonElement);
        this.dialogTemplate = required(dialogRegistry, '[data-cm-dialog-shell]', HTMLTemplateElement);
        this.dialogContentTemplates = new Map(
            Array.from(dialogRegistry.querySelectorAll('[data-cm-dialog-content]'), templateNode => [
                templateNode.dataset.cmDialogContent,
                templateNode,
            ]),
        );
        this.componentTemplates = new Map(
            Array.from(componentRegistry.querySelectorAll('[data-cm-component]'), templateNode => [
                templateNode.dataset.cmComponent,
                templateNode,
            ]),
        );

        required(root, '[data-cm-close]', HTMLButtonElement).addEventListener('click', () => this.close());
        required(root, '[data-cm-refresh]', HTMLButtonElement).addEventListener('click', () => this.refresh());
        this.groupOwnersButton.addEventListener('click', () => this.#toggleGrouping('owners'));
        this.groupSplitsButton.addEventListener('click', () => this.#toggleGrouping('splits'));
        this.search.addEventListener('input', () => { this.page = 0; this.#filter(); });
        this.previous.addEventListener('click', () => { this.page--; this.#render(); });
        this.next.addEventListener('click', () => { this.page++; this.#render(); });
        this.#syncGroupingButtons();
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
        this.root.classList.remove('cm-hidden');
        if (!this.records) await this.refresh();
        else this.updateRuntimeState();
    }

    close() {
        this.root.classList.add('cm-hidden');
    }

    #setState(message, error = false) {
        this.state.textContent = message;
        this.state.classList.toggle('cm-hidden', !message);
        this.state.classList.toggle('cm-error', error);
    }

    updateRuntimeState() {
        const generating = this.isGenerating();
        this.#setState(generating
            ? '聊天正在生成：当前仅允许浏览和查看备份'
            : this.splitter.running ? '分割任务正在执行' : '');
        if (this.activeSplitRoot?.isConnected) this.activeSplitSync?.();
        this.#render();
    }

    async refresh() {
        if (this.loading) return;
        this.loading = true;
        this.#setState('正在读取全部聊天…');
        try {
            const data = await this.api.getRecentChats();
            if (!Array.isArray(data)) throw new Error('全部聊天接口返回格式无效');
            const context = this.getContext();
            this.records = data.map(item => {
                const isGroup = item.group !== undefined && item.group !== null;
                const owner = isGroup
                    ? context.groups.find(group => String(group.id) === String(item.group))
                    : context.characters.find(character => character.avatar === item.avatar);
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
            this.page = 0;
            this.#filter();
            this.updateRuntimeState();
        } catch (error) {
            this.#setState(error.message, true);
            notify('error', error.message);
        } finally {
            this.loading = false;
        }
    }

    #filter() {
        const query = this.search.value.trim().toLocaleLowerCase();
        this.filtered = (this.records ?? []).filter(record => !query || [record.ownerName, record.fileId].some(value => value.toLocaleLowerCase().includes(query)));
        this.#render();
    }

    #render() {
        if (!this.list) return;
        this.list.replaceChildren();
        const units = this.groupOwners
            ? groupOwnerRecords(this.filtered, this.groupSplits, this.records ?? [])
            : this.groupSplits
                ? groupSplitRecords(this.filtered, this.records ?? [])
                : this.filtered.map(record => ({ type: 'record', key: `record:${chatKey(record)}`, record }));
        const totalPages = Math.max(1, Math.ceil(units.length / PAGE_SIZE));
        this.page = Math.max(0, Math.min(this.page, totalPages - 1));
        const pageUnits = units.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE);
        for (const unit of pageUnits) this.list.append(this.#renderUnit(unit));
        if (!pageUnits.length && !this.loading) this.list.append(this.#state('没有可显示的聊天', { empty: true }));
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
        this.onViewOptionsChange({ groupOwners: this.groupOwners, groupSplits: this.groupSplits });
    }

    /** 同步分组按钮的可访问状态与视觉状态 */
    #syncGroupingButtons() {
        for (const [button, active] of [[this.groupOwnersButton, this.groupOwners], [this.groupSplitsButton, this.groupSplits]]) {
            button.setAttribute('aria-pressed', String(active));
            button.classList.toggle('cm-active', active);
        }
    }

    /**
     * 创建角色或群组的折叠显示单元
     * @param {object} group 所有者分组
     * @returns {HTMLElement} 分组节点
     */
    #ownerGroup(group) {
        const root = this.#component('owner-group');
        const image = this.#mount(root, '[data-cm-owner-avatar]', HTMLImageElement);
        const toggle = this.#mount(root, '[data-cm-owner-toggle]', HTMLButtonElement);
        const children = this.#mount(root, '[data-cm-owner-children]');
        const expanded = this.expandedOwners.has(group.key);
        image.src = group.avatarUrl;
        image.alt = group.ownerName;
        this.#mount(root, '[data-cm-owner-name]').textContent = group.ownerName;
        const splitCount = group.children.filter(child => child.type === 'split-group').length;
        this.#mount(root, '[data-cm-owner-summary]').textContent = `${group.records.length} 条聊天${splitCount ? ` · ${splitCount} 个分卷组` : ''}`;
        this.#configureGroupToggle(toggle, expanded, () => {
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
        const root = this.#component('split-group');
        const toggle = this.#mount(root, '[data-cm-split-toggle]', HTMLButtonElement);
        const children = this.#mount(root, '[data-cm-split-children]');
        const continueButton = this.#mount(root, '[data-cm-split-continue]', HTMLButtonElement);
        const incremental = deriveIncrementalSplit(group);
        const expanded = this.expandedSplits.has(group.key);
        const first = group.records[0].split;
        const last = group.records.at(-1).split;
        this.#mount(root, '[data-cm-split-group-name]').textContent = group.rootChatId;
        this.#mount(root, '[data-cm-split-group-summary]').textContent = `${group.records.length} 个分卷 · #${first.start}–#${last.end}${group.sourceRecord ? ' · 含源聊天' : ''}`;
        this.#mount(root, '[data-cm-split-group-incremental]').textContent = incremental.reason;
        continueButton.disabled = !incremental.available || this.isGenerating() || this.splitter.running;
        continueButton.title = incremental.available ? incremental.reason : `暂不可增量分卷：${incremental.reason}`;
        this.#bindButton(continueButton, () => this.openSplit(incremental.sourceRecord, incremental.options));
        this.#configureGroupToggle(toggle, expanded, () => {
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
     * 配置折叠按钮并保持图标、文案和 aria 状态一致
     * @param {HTMLButtonElement} button 按钮
     * @param {boolean} expanded 是否展开
     * @param {()=>void} handler 点击处理
     */
    #configureGroupToggle(button, expanded, handler) {
        button.setAttribute('aria-expanded', String(expanded));
        this.#mount(button, '[data-cm-group-toggle-text]').textContent = expanded ? '收起' : '展开';
        this.#mount(button, '[data-cm-group-chevron]').classList.toggle('fa-chevron-up', expanded);
        this.#mount(button, '[data-cm-group-chevron]').classList.toggle('fa-chevron-down', !expanded);
        this.#bindButton(button, handler);
    }

    #chatRow(record, { source = false } = {}) {
        const row = this.#component('chat-row');
        const image = this.#mount(row, '[data-cm-chat-avatar]', HTMLImageElement);
        const name = this.#mount(row, '[data-cm-chat-name]');
        const owner = this.#mount(row, '[data-cm-chat-owner]');
        const file = this.#mount(row, '[data-cm-chat-file]');
        const sourceBadge = this.#mount(row, '[data-cm-chat-source]');
        const date = this.#mount(row, '[data-cm-chat-date]', HTMLTimeElement);
        const preview = this.#mount(row, '[data-cm-chat-preview]');
        const countWrap = this.#mount(row, '[data-cm-chat-count-wrap]');
        const count = this.#mount(row, '[data-cm-chat-count]');
        const size = this.#mount(row, '[data-cm-chat-size]');
        const open = this.#mount(row, '[data-cm-chat-open]', HTMLButtonElement);
        const backup = this.#mount(row, '[data-cm-chat-backups]', HTMLButtonElement);
        const split = this.#mount(row, '[data-cm-chat-split]', HTMLButtonElement);
        row.classList.toggle('cm-selected', this.selectedKey === chatKey(record));
        row.classList.toggle('cm-source-record', source);
        sourceBadge.classList.toggle('cm-hidden', !source);
        row.title = `打开 ${record.ownerName} / ${record.fileId}`;
        image.src = record.avatarUrl;
        image.alt = record.ownerName;
        name.title = `${record.ownerName} - ${record.fileId}`;
        owner.textContent = record.ownerName;
        file.textContent = record.fileId;
        date.textContent = this.#formatDate(record.lastMessageAt);
        preview.textContent = record.preview;
        preview.title = record.preview;
        countWrap.title = `${record.messageCount} 层消息`;
        count.textContent = String(record.messageCount);
        size.textContent = record.fileSize;
        const openRecord = async () => {
            this.selectedKey = chatKey(record);
            this.#render();
            await this.openRecord(record);
            this.close();
        };
        this.#bindButton(open, openRecord);
        this.#bindButton(backup, () => this.openBackups(record));
        this.#bindButton(split, () => this.openSplit(record));
        open.disabled = this.isGenerating() || this.splitter.running;
        split.disabled = this.isGenerating() || this.splitter.running || record.messageCount < 1;

        row.addEventListener('click', event => {
            if (event.target.closest('button')) return;
            void openRecord().catch(error => notify('error', error.message));
        });
        return row;
    }

    async openBackups(record) {
        const dialog = this.#dialog(['对应备份', record.ownerName, record.fileId], 'backups');
        const status = this.#mount(dialog.body, '[data-cm-backup-status]');
        const statusText = this.#mount(dialog.body, '[data-cm-backup-status-text]');
        const elapsed = this.#mount(dialog.body, '[data-cm-backup-elapsed]');
        const progress = this.#mount(dialog.body, '[data-cm-backup-progress]');
        const progressValue = this.#mount(dialog.body, '[data-cm-backup-progress-value]');
        const summary = this.#mount(dialog.body, '[data-cm-backup-summary]');
        const results = this.#mount(dialog.body, '[data-cm-backup-results]');
        const startedAt = Date.now();
        const updateElapsed = () => {
            elapsed.textContent = `已等待 ${((Date.now() - startedAt) / 1_000).toFixed(1)} 秒`;
        };
        const timer = setInterval(updateElapsed, 250);
        const stopLoading = () => clearInterval(timer);
        dialog.signal.addEventListener('abort', stopLoading, { once: true });
        let found = 0;
        let checked = 0;
        let candidateCount = 0;
        const rows = new Map();
        const refreshSummary = () => {
            summary.textContent = `候选 ${candidateCount} 个 · 已检查 ${checked} 个 · 已确认 ${found} 个`;
            summary.classList.remove('cm-hidden');
        };
        try {
            const matches = await this.backups.find(record, {
                onCandidates: candidates => {
                    candidateCount = candidates.length;
                    statusText.textContent = candidates.length ? '备份列表已载入，正在检查文件内容…' : '备份列表已载入';
                    for (const candidate of candidates) {
                        const backup = { ...candidate, status: 'pending', reason: '等待读取并匹配' };
                        const row = this.#backupRow(record, backup, () => {
                            dialog.close();
                            this.close();
                        });
                        rows.set(candidate.file_name, { row, backup });
                        results.append(row);
                    }
                    refreshSummary();
                },
                onProgress: (done, total) => {
                    checked = done;
                    statusText.textContent = `正在检查备份文件 · ${done} / ${total}`;
                    if (total > 0) {
                        progress.classList.remove('cm-loading-progress-indeterminate');
                        progress.setAttribute('aria-valuemin', '0');
                        progress.setAttribute('aria-valuemax', String(total));
                        progress.setAttribute('aria-valuenow', String(done));
                        progressValue.style.width = `${Math.min(100, (done / total) * 100)}%`;
                    }
                    refreshSummary();
                },
                onResult: (candidate, match) => {
                    const entry = rows.get(candidate.file_name);
                    if (!entry) return;
                    if (!match) {
                        entry.row.remove();
                        rows.delete(candidate.file_name);
                        refreshSummary();
                        return;
                    }
                    if (['matched', 'confirm'].includes(match.status)) found++;
                    Object.assign(entry.backup, match);
                    this.#updateBackupRow(entry.row, record, entry.backup);
                    refreshSummary();
                },
            }, dialog.signal);
            stopLoading();
            status.remove();
            summary.textContent = `显示 ${matches.length} 个候选结果 · 原聊天 ${record.fileSize} · ${record.messageCount} 层`;
            summary.classList.remove('cm-hidden');
            if (!matches.length) {
                results.append(this.#state('没有找到能够关联到该聊天的备份', { empty: true }));
                return;
            }
        } catch (error) {
            if (dialog.signal.aborted) return;
            stopLoading();
            for (const { row, backup } of rows.values()) {
                if (backup.status !== 'pending') continue;
                backup.status = 'error';
                backup.reason = `扫描中断：${error.message}`;
                this.#updateBackupRow(row, record, backup);
            }
            status.replaceWith(this.#state(error.message, { error: true }));
            notify('error', error.message);
        }
    }

    /**
     * 填充单个备份结果卡片
     * @param {object} record 原聊天记录
     * @param {object} backup 备份信息
     * @param {()=>void} onRestored 恢复完成回调
     * @returns {HTMLElement}
     */
    #backupRow(record, backup, onRestored) {
        const row = this.#component('backup-row');
        this.#updateBackupRow(row, record, backup);
        const restore = this.#mount(row, '[data-cm-backup-restore]', HTMLButtonElement);
        this.#bindButton(restore, async () => {
            if (!['matched', 'confirm'].includes(backup.status)) return;
            restore.disabled = true;
            try {
                await this.restoreBackup(record, backup);
                notify('success', '备份已恢复为一份新聊天');
                onRestored();
            } finally {
                restore.disabled = !['matched', 'confirm'].includes(backup.status);
            }
        });
        this.#bindButton(this.#mount(row, '[data-cm-backup-view]', HTMLButtonElement), () => this.#viewBackup(backup));
        this.#bindButton(this.#mount(row, '[data-cm-backup-download]', HTMLButtonElement), () => this.backups.download(backup.file_name));
        return row;
    }

    /**
     * 原位刷新候选备份卡片的匹配状态
     * @param {HTMLElement} row 备份卡片
     * @param {object} record 原聊天记录
     * @param {object} backup 当前备份状态
     */
    #updateBackupRow(row, record, backup) {
        this.#mount(row, '[data-cm-backup-name]').textContent = backup.file_name;
        const status = this.#mount(row, '[data-cm-backup-status]');
        status.textContent = backup.status === 'pending' ? '等待检查' : backup.status === 'matched' ? '完整匹配' : backup.status === 'confirm' ? '部分相关' : '读取异常';
        status.dataset.state = backup.status === 'pending' ? 'loading' : backup.status === 'matched' ? 'ready' : backup.status === 'confirm' ? 'warning' : 'error';
        this.#mount(row, '[data-cm-backup-created]').textContent = this.#formatBackupDate(backup.file_name);
        this.#mount(row, '[data-cm-backup-last-message]').textContent = this.#formatDate(backup.last_mes);
        this.#mount(row, '[data-cm-backup-size]').textContent = `${backup.file_size} · ${backup.chat_items} / ${record.messageCount} 层`;
        this.#mount(row, '[data-cm-backup-reason]').textContent = `匹配依据：${backup.reason ?? '未提供'}`;
        this.#mount(row, '[data-cm-backup-preview]').textContent = String(backup.mes ?? '没有可显示的最后消息');
        const restore = this.#mount(row, '[data-cm-backup-restore]', HTMLButtonElement);
        restore.disabled = !['matched', 'confirm'].includes(backup.status);
    }

    async #viewBackup(backup) {
        const dialog = this.#dialog(`查看备份 · ${backup.file_name}`, 'backup-viewer');
        let page = 0;
        const pageSize = 50;
        const content = this.#mount(dialog.body, '[data-cm-message-list]');
        const previous = this.#mount(dialog.body, '[data-cm-message-previous]', HTMLButtonElement);
        const label = this.#mount(dialog.body, '[data-cm-message-page]');
        const next = this.#mount(dialog.body, '[data-cm-message-next]', HTMLButtonElement);
        this.#bindButton(previous, () => { page--; return load(); });
        this.#bindButton(next, () => { page++; return load(); });
        const load = async () => {
            content.replaceChildren(this.#state('正在读取该页…'));
            try {
                const messages = await this.backups.readPage(backup.file_name, page, pageSize, dialog.signal);
                content.replaceChildren();
                messages.forEach((message, index) => {
                    const item = this.#component('message');
                    this.#mount(item, '[data-cm-message-name]').textContent = `#${page * pageSize + index} ${message.name ?? ''}`;
                    this.#mount(item, '[data-cm-message-date]', HTMLTimeElement).textContent = this.#formatDate(message.send_date);
                    this.#mount(item, '[data-cm-message-content]').textContent = String(message.mes ?? '');
                    content.append(item);
                });
                const pages = Math.max(1, Math.ceil(Number(backup.chat_items ?? 0) / pageSize));
                label.textContent = `${page + 1} / ${pages}`;
                previous.disabled = page <= 0;
                next.disabled = page >= pages - 1;
            } catch (error) {
                if (dialog.signal.aborted) return;
                content.replaceChildren(this.#state(error.message, { error: true }));
            }
        };
        await load();
    }

    async openSplit(record, initialOptions = {}) {
        if (this.isGenerating()) return notify('warning', '聊天正在生成，当前不能分割');
        this.activeSplitClose?.();
        const incremental = Boolean(initialOptions.incremental);
        const dialog = this.#dialog([incremental ? '继续分卷' : '分割聊天', record.ownerName, initialOptions.outputRootChatId ?? record.fileId], 'split');
        this.activeSplitRoot = dialog.root;
        this.activeSplitClose = dialog.close;
        const summary = this.#mount(dialog.body, '[data-cm-split-summary]');
        const previewStatus = this.#mount(dialog.body, '[data-cm-split-preview-status]');
        const previewDetail = this.#mount(dialog.body, '[data-cm-split-preview-detail]');
        const groupConfigField = this.#mount(dialog.body, '[data-cm-split-group-config-field]');
        const groupConfig = this.#mount(dialog.body, '[data-cm-split-group-config]', HTMLSelectElement);
        const mode = this.#mount(dialog.body, '[data-cm-split-mode]', HTMLSelectElement);
        const start = this.#mount(dialog.body, '[data-cm-split-start]', HTMLInputElement);
        const end = this.#mount(dialog.body, '[data-cm-split-end]', HTMLInputElement);
        const chunk = this.#mount(dialog.body, '[data-cm-split-chunk]', HTMLInputElement);
        const chunkRow = this.#mount(dialog.body, '[data-cm-split-chunk-field]');
        const preview = this.#mount(dialog.body, '[data-cm-split-preview]');
        const notice = this.#mount(dialog.body, '[data-cm-split-notice]');
        const acknowledge = this.#mount(dialog.body, '[data-cm-split-acknowledge]', HTMLInputElement);
        const confirm = this.#mount(dialog.body, '[data-cm-split-confirm]', HTMLButtonElement);
        const stop = this.#mount(dialog.body, '[data-cm-split-stop]', HTMLButtonElement);
        const maxFloor = Math.max(0, record.messageCount - 1);
        mode.value = initialOptions.mode ?? 'range';
        const initialStart = Number(initialOptions.start ?? 0);
        const initialEnd = Number(initialOptions.end ?? maxFloor);
        const initialChunk = Number(initialOptions.chunkSize ?? Math.min(500, Math.max(1, record.messageCount)));
        summary.textContent = incremental
            ? `增量来源：最后一卷新增楼层 · 本地 #${initialStart}–#${initialEnd}${mode.value === 'fixed' ? ` · 每卷 ${initialChunk} 层` : ''}`
            : `原聊天 ${record.fileSize} · ${record.messageCount} 层 · 可用范围 #0–#${maxFloor}`;
        this.#configureNumberInput(start, initialStart, 0, maxFloor);
        this.#configureNumberInput(end, initialEnd, 0, maxFloor);
        this.#configureNumberInput(chunk, initialChunk, 1, Math.max(1, record.messageCount));
        chunkRow.classList.toggle('cm-hidden', mode.value !== 'fixed');
        const groupConfigs = Array.isArray(initialOptions.groupConfigs) ? initialOptions.groupConfigs : [];
        if (incremental) {
            groupConfigField.classList.remove('cm-hidden');
            groupConfigs.forEach((config, index) => {
                const label = `固定楼层 · 每卷 ${config.chunkSize} 层`;
                groupConfig.append(new Option(label, String(index)));
            });
        }

        let plan = null;
        let stableSource = null;
        let previewTimer = null;
        let previewController = null;
        let previewRevision = 0;
        let previewing = false;
        let executing = false;

        const syncGroupConfig = () => {
            if (!incremental) return;
            const index = groupConfigs.findIndex(config => config.mode === mode.value && Number(config.chunkSize) === Number(chunk.value));
            if (index >= 0) {
                groupConfig.value = String(index);
                return;
            }
            let custom = groupConfig.querySelector('option[value="custom"]');
            if (!custom) {
                custom = new Option('自定义配置', 'custom');
                groupConfig.append(custom);
            }
            groupConfig.value = 'custom';
        };

        const setPreviewStatus = (text, state = '') => {
            previewStatus.textContent = text;
            previewStatus.dataset.state = state;
        };
        const readOptions = () => {
            const required = mode.value === 'fixed' ? [start, end, chunk] : [start, end];
            if (required.some(input => input.value === '' || !input.checkValidity())) throw new Error('请输入有效的楼层范围');
            return {
                mode: mode.value,
                start: Number(start.value),
                end: Number(end.value),
                chunkSize: mode.value === 'fixed' ? Number(chunk.value) : undefined,
                sequenceStart: initialOptions.sequenceStart,
                incremental,
                outputRootChatId: initialOptions.outputRootChatId,
                rangeOffset: initialOptions.rangeOffset,
            };
        };
        const syncControls = () => {
            const blocked = executing || this.isGenerating() || this.splitter.running;
            for (const input of [mode, start, end, chunk, groupConfig]) input.disabled = blocked;
            acknowledge.disabled = blocked;
            confirm.disabled = blocked || previewing || !plan || !acknowledge.checked;
        };
        const runPreview = async (revision) => {
            if (revision !== previewRevision || executing) return;
            let options;
            try {
                options = readOptions();
            } catch (error) {
                plan = null;
                setPreviewStatus('参数有误', 'error');
                preview.replaceChildren(this.#state(error.message, { error: true }));
                syncControls();
                return;
            }
            const controller = new AbortController();
            previewController = controller;
            const abortPreview = () => controller.abort();
            dialog.signal.addEventListener('abort', abortPreview, { once: true });
            previewing = true;
            setPreviewStatus('正在更新', 'loading');
            preview.replaceChildren(this.#state(stableSource ? '正在计算新的分卷方案…' : '正在读取原聊天并计算预览…'));
            syncControls();
            try {
                const nextPlan = await this.splitter.prepare(record, options, controller.signal, stableSource);
                if (revision !== previewRevision || controller.signal.aborted) return;
                plan = nextPlan;
                stableSource ??= nextPlan.source;
                preview.replaceChildren();
                plan.parts.forEach(part => preview.append(this.#splitPart(describePart(part))));
                const totalMessages = plan.parts.reduce((sum, part) => sum + part.messages.length, 0);
                previewDetail.textContent = `${plan.parts.length} 个分卷 · 共 ${totalMessages} 层`;
                setPreviewStatus('预览已更新', 'ready');
                notice.classList.remove('cm-hidden');
            } catch (error) {
                if (controller.signal.aborted || dialog.signal.aborted || revision !== previewRevision) return;
                plan = null;
                previewDetail.textContent = '';
                setPreviewStatus('无法预览', 'error');
                preview.replaceChildren(this.#state(error.message, { error: true }));
                notice.classList.add('cm-hidden');
            } finally {
                dialog.signal.removeEventListener('abort', abortPreview);
                if (revision === previewRevision) {
                    previewing = false;
                    previewController = null;
                    syncControls();
                }
            }
        };
        const schedulePreview = (delay = 300) => {
            if (executing) return;
            previewRevision++;
            const revision = previewRevision;
            if (previewTimer !== null) clearTimeout(previewTimer);
            previewController?.abort();
            previewController = null;
            previewing = false;
            plan = null;
            acknowledge.checked = false;
            notice.classList.add('cm-hidden');
            previewDetail.textContent = '';
            setPreviewStatus(delay ? '等待更新' : '正在更新', 'loading');
            preview.replaceChildren(this.#state(delay ? '参数修改中，稍后自动更新预览…' : '正在准备预览…'));
            syncControls();
            previewTimer = setTimeout(() => {
                previewTimer = null;
                void runPreview(revision);
            }, delay);
        };

        this.#bindButton(confirm, async () => {
            if (!plan || !acknowledge.checked) return;
            if (this.isGenerating()) return notify('warning', '聊天正在生成，不能写入分卷');
            let refreshSource = false;
            executing = true;
            if (previewTimer !== null) clearTimeout(previewTimer);
            previewController?.abort();
            setPreviewStatus('正在创建', 'loading');
            syncControls();
            stop.classList.remove('cm-hidden');
            dialog.setClosable(false);
            try {
                const task = await this.splitter.execute(plan, {
                    shouldPause: () => this.isGenerating(),
                    onUpdate: current => this.#renderTask(preview, current),
                });
                this.#renderTask(preview, task);
                plan = null;
                notice.classList.add('cm-hidden');
                setPreviewStatus(task.status === 'complete' ? '创建完成' : '任务已暂停', task.status === 'complete' ? 'ready' : 'warning');
                previewDetail.textContent = task.status === 'complete' ? '所有分卷均已写入并校验' : '可以从恢复任务继续执行';
                notify(task.status === 'complete' ? 'success' : 'warning', task.status === 'complete' ? '分割完成' : '任务已安全暂停');
                await this.refresh();
            } catch (error) {
                setPreviewStatus('创建失败', 'error');
                notify('error', error.message);
                if (error.task) this.#renderTask(preview, error.task);
                refreshSource = error.message.includes('原聊天在预览后发生变化');
            } finally {
                dialog.setClosable(true);
                stop.classList.add('cm-hidden');
                executing = false;
                syncControls();
                if (refreshSource) {
                    stableSource = null;
                    schedulePreview(0);
                }
            }
        });
        this.#bindButton(stop, () => this.splitter.requestStop());
        acknowledge.addEventListener('change', () => syncControls());
        mode.addEventListener('change', () => {
            chunkRow.classList.toggle('cm-hidden', mode.value !== 'fixed');
            syncGroupConfig();
            schedulePreview();
        });
        for (const input of [start, end]) input.addEventListener('input', () => schedulePreview());
        chunk.addEventListener('input', () => {
            syncGroupConfig();
            schedulePreview();
        });
        groupConfig.addEventListener('change', () => {
            if (groupConfig.value === 'custom') return;
            const config = groupConfigs[Number(groupConfig.value)];
            if (!config) return;
            mode.value = config.mode;
            chunk.value = String(config.chunkSize);
            chunkRow.classList.toggle('cm-hidden', mode.value !== 'fixed');
            schedulePreview();
        });
        dialog.signal.addEventListener('abort', () => {
            if (previewTimer !== null) clearTimeout(previewTimer);
            previewController?.abort();
        }, { once: true });
        this.activeSplitSync = syncControls;
        syncGroupConfig();
        syncControls();
        schedulePreview(0);
    }

    async showRecovery(tasks) {
        if (!tasks.length) return;
        const dialog = this.#dialog('检测到未完成的分割任务', 'recovery');
        const list = this.#mount(dialog.body, '[data-cm-recovery-list]');
        for (const task of tasks) {
            const card = this.#component('recovery-task');
            this.#mount(card, '[data-cm-recovery-name]').textContent = `${task.record.ownerName} / ${task.record.fileId}`;
            this.#mount(card, '[data-cm-recovery-parts]').textContent = task.parts.map(part => `${part.fileId}：${part.status}`).join('；');
            const resume = this.#mount(card, '[data-cm-recovery-resume]', HTMLButtonElement);
            const clear = this.#mount(card, '[data-cm-recovery-clear]', HTMLButtonElement);
            this.#bindButton(resume, async () => {
                if (this.isGenerating()) return notify('warning', '聊天正在生成，不能继续任务');
                resume.disabled = true;
                try {
                    const plan = await this.splitter.restorePlan(task);
                    await this.splitter.execute(plan, { resumeTask: task, shouldPause: () => this.isGenerating() });
                    card.remove();
                    notify('success', '任务已完成');
                    await this.refresh();
                } catch (error) {
                    notify('error', error.message);
                } finally {
                    resume.disabled = false;
                }
            });
            this.#bindButton(clear, async () => {
                await this.splitter.journal.remove(task.id);
                card.remove();
            });
            list.append(card);
        }
    }

    #renderTask(container, task) {
        container.replaceChildren();
        task.parts.forEach(part => container.append(this.#splitPart(
            `${part.fileId}　${part.status}${part.error ? `：${part.error}` : ''}`,
            part.status,
        )));
    }

    /**
     * 创建分卷预览或执行状态行
     * @param {string} text 展示文本
     * @param {string} status 分卷状态
     * @returns {HTMLElement}
     */
    #splitPart(text, status = '') {
        const row = this.#component('split-part');
        if (status) row.classList.add(`cm-status-${status}`);
        this.#mount(row, '[data-cm-split-part-text]').textContent = text;
        return row;
    }

    /**
     * 创建统一的空白、加载或错误状态
     * @param {string} text 状态文本
     * @param {{error?:boolean,empty?:boolean}} options 状态样式
     * @returns {HTMLElement}
     */
    #state(text, { error = false, empty = false } = {}) {
        const state = this.#component('state');
        state.classList.toggle('cm-error', error);
        state.classList.toggle('cm-empty', empty);
        this.#mount(state, '[data-cm-state-text]').textContent = text;
        return state;
    }

    /**
     * 从静态外壳和内容模板创建一个只能显式关闭的可叠加弹窗
     * @param {string | string[]} title 标题或分层标题
     * @param {string} contentId 内容模板名称
     * @returns {{root:HTMLElement,body:HTMLElement,signal:AbortSignal,close:()=>void,setClosable:(value:boolean)=>void}}
     */
    #dialog(title, contentId) {
        const controller = new AbortController();
        const fragment = this.dialogTemplate.content.cloneNode(true);
        const root = fragment.querySelector('[data-cm-dialog-overlay]');
        const panel = fragment.querySelector('[data-cm-dialog-panel]');
        const heading = fragment.querySelector('[data-cm-dialog-title]');
        const closeButton = fragment.querySelector('[data-cm-dialog-close]');
        const body = fragment.querySelector('[data-cm-dialog-body]');
        if (!(root instanceof HTMLElement)
            || !(panel instanceof HTMLElement)
            || !(heading instanceof HTMLElement)
            || !(closeButton instanceof HTMLButtonElement)
            || !(body instanceof HTMLElement)) {
            throw new Error('聊天管理弹窗模板无效');
        }
        panel.classList.add(`cm-dialog-${contentId}`);
        this.dialogSequence = (this.dialogSequence ?? 0) + 1;
        heading.id = `cm_dialog_title_${this.dialogSequence}`;
        panel.setAttribute('aria-labelledby', heading.id);
        if (Array.isArray(title)) {
            heading.classList.add('cm-dialog-title-lines');
            heading.title = title.join(' / ');
            heading.append(...title.map(text => element('span', { text })));
        } else {
            heading.textContent = title;
        }
        const contentTemplate = this.dialogContentTemplates.get(contentId);
        if (!(contentTemplate instanceof HTMLTemplateElement)) throw new Error(`未找到弹窗模板 ${contentId}`);
        body.append(contentTemplate.content.cloneNode(true));
        const remove = () => {
            controller.abort();
            root.remove();
        };
        closeButton.addEventListener('click', remove);
        document.body.append(root);
        return { root, body, signal: controller.signal, close: remove, setClosable: value => { closeButton.disabled = !value; } };
    }

    /**
     * 将静态模板中的按钮接入统一的异步错误处理
     * @param {HTMLButtonElement} button 按钮元素
     * @param {(event: MouseEvent) => unknown | Promise<unknown>} handler 点击处理函数
     */
    #bindButton(button, handler) {
        button.addEventListener('click', event => {
            event.stopPropagation();
            Promise.resolve(handler(event)).catch(error => {
                console.error(error);
                notify('error', error.message);
            });
        });
    }

    /**
     * 克隆一个静态组件模板
     * @param {string} name 组件名称
     * @returns {HTMLElement}
     */
    #component(name) {
        const template = this.componentTemplates.get(name);
        if (!(template instanceof HTMLTemplateElement)) throw new Error(`未找到组件模板 ${name}`);
        const root = template.content.firstElementChild?.cloneNode(true);
        if (!(root instanceof HTMLElement)) throw new Error(`组件模板 ${name} 无有效根节点`);
        return root;
    }

    /**
     * 读取并校验静态模板中的挂载点
     * @template {Element} T
     * @param {ParentNode} root 查询根节点
     * @param {string} selector 挂载点选择器
     * @param {{new(...args: any[]): T}} [type=HTMLElement] 期望的元素类型
     * @returns {T}
     */
    #mount(root, selector, type = HTMLElement) {
        const target = root.querySelector(selector);
        if (!(target instanceof type)) throw new Error(`聊天管理模板缺少挂载点 ${selector}`);
        return target;
    }

    /**
     * 配置静态模板中的数字输入框边界
     * @param {HTMLInputElement} input 数字输入框
     * @param {number} value 初始值
     * @param {number} min 最小值
     * @param {number} max 最大值
     */
    #configureNumberInput(input, value, min, max) {
        input.value = String(value);
        input.min = String(min);
        input.max = String(max);
        input.step = '1';
    }

    /**
     * 从酒馆原生备份文件名末尾解析创建时间
     * @param {string} fileName 备份文件名
     * @returns {string}
     */
    #formatBackupDate(fileName) {
        const match = String(fileName).match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.jsonl$/i);
        if (!match) return '无法识别';
        const [, year, month, day, hour, minute, second] = match;
        return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).toLocaleString();
    }

    #formatDate(value) {
        const date = new Date(value);
        return Number.isNaN(date.valueOf()) ? String(value ?? '') : date.toLocaleString();
    }
}
