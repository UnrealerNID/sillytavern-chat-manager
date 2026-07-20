import { formatBytes, parseBytes, parseJsonlResponse, stripJsonl } from './utils.js';

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

export class FileInventoryUi {
    /**
     * @param {object} dependencies 依赖项
     * @param {()=>any} dependencies.getContext 酒馆上下文提供器
     * @param {import('./api.js').ChatManagerApi} dependencies.api 酒馆接口
     * @param {import('./backups.js').BackupService} dependencies.backups 备份服务
     * @param {(record:object)=>Promise<void>} dependencies.openRecord 打开聊天回调
     * @param {string} dependencies.template 独立文件清单模板
     */
    constructor({ getContext, api, backups, openRecord, template }) {
        this.getContext = getContext;
        this.api = api;
        this.backups = backups;
        this.openRecord = openRecord;
        this.items = { chats: [], backups: [], orphanBackups: [] };
        this.mode = 'all';
        this.scanned = { orphanBackups: false };
        this.activeKind = 'chats';
        this.page = 0;
        this.controller = null;
        this.orphanController = null;
        this.reportToken = '';
        this.dataMaidReport = null;
        this.reportShared = false;
        this.orphanBackupCache = null;
        this.chatInventoryLoaded = false;
        this.scanRevision = 0;
        this.selected = new Map();
        this.viewerController = null;
        this.pendingDelete = [];
        this.#build(template);
    }

    /** @param {string} template 独立面板模板 */
    #build(template) {
        const holder = document.createElement('template');
        holder.innerHTML = template.trim();
        const root = holder.content.firstElementChild;
        if (!(root instanceof HTMLElement)) throw new Error('文件清单模板无效');
        const required = (selector, type = HTMLElement) => {
            const node = root.querySelector(selector);
            if (!(node instanceof type)) throw new Error(`文件清单模板缺少 ${selector}`);
            return node;
        };
        this.root = root;
        this.search = required('[data-cm-inventory-search]', HTMLInputElement);
        this.sort = required('[data-cm-inventory-sort]', HTMLSelectElement);
        this.nativeCleanup = required('[data-cm-inventory-open-cleanup]', HTMLButtonElement);
        this.scanOrphanBackups = required('[data-cm-inventory-scan-backups]', HTMLButtonElement);
        this.status = required('[data-cm-inventory-status]');
        this.statusText = required('[data-cm-inventory-status-text]');
        this.statusDetail = required('[data-cm-inventory-status-detail]');
        this.spinner = required('[data-cm-inventory-spinner]');
        this.progress = required('[data-cm-inventory-progress]');
        this.progressValue = required('[data-cm-inventory-progress-value]');
        this.list = required('[data-cm-inventory-list]');
        this.summary = required('[data-cm-inventory-summary]');
        this.pageLabel = required('[data-cm-inventory-page]');
        this.previous = required('[data-cm-inventory-previous]', HTMLButtonElement);
        this.next = required('[data-cm-inventory-next]', HTMLButtonElement);
        this.refreshButton = required('[data-cm-inventory-refresh]', HTMLButtonElement);
        this.orphanActions = required('[data-cm-inventory-orphan-actions]');
        this.selection = required('[data-cm-inventory-selection]');
        this.selectAll = required('[data-cm-inventory-select-all]', HTMLButtonElement);
        this.deleteSelected = required('[data-cm-inventory-delete-selected]', HTMLButtonElement);
        this.selectedCount = required('[data-cm-inventory-selected-count]');
        this.rowTemplate = required('[data-cm-inventory-row-template]', HTMLTemplateElement);
        this.messageTemplate = required('[data-cm-inventory-message-template]', HTMLTemplateElement);
        this.deleteTemplate = required('[data-cm-inventory-delete-template]', HTMLTemplateElement);
        this.viewer = required('[data-cm-inventory-viewer]');
        this.viewerTitle = required('[data-cm-inventory-viewer-title]');
        this.viewerSummary = required('[data-cm-inventory-viewer-summary]');
        this.messages = required('[data-cm-inventory-messages]');
        this.messagePrevious = required('[data-cm-inventory-message-previous]', HTMLButtonElement);
        this.messageNext = required('[data-cm-inventory-message-next]', HTMLButtonElement);
        this.messagePage = required('[data-cm-inventory-message-page]');
        this.deleteDialog = required('[data-cm-inventory-delete-dialog]');
        this.deleteSummary = required('[data-cm-inventory-delete-summary]');
        this.deleteList = required('[data-cm-inventory-delete-list]');
        this.deleteCancel = required('[data-cm-inventory-delete-cancel]', HTMLButtonElement);
        this.deleteConfirm = required('[data-cm-inventory-delete-confirm]', HTMLButtonElement);
        this.modes = new Map(Array.from(root.querySelectorAll('[data-cm-inventory-mode]'), button => [button.dataset.cmInventoryMode, button]));
        this.tabs = new Map(Array.from(root.querySelectorAll('[data-cm-inventory-tab]'), button => [button.dataset.cmInventoryTab, button]));
        this.counts = {
            chats: required('[data-cm-inventory-chat-count]'),
            backups: required('[data-cm-inventory-backup-count]'),
            orphanBackups: required('[data-cm-inventory-orphan-backup-count]'),
        };
        required('[data-cm-inventory-close]', HTMLButtonElement).addEventListener('click', () => this.close());
        this.refreshButton.addEventListener('click', () => void this.refresh());
        this.search.addEventListener('input', () => { this.page = 0; this.#render(); });
        this.sort.addEventListener('change', () => { this.page = 0; this.#render(); });
        this.previous.addEventListener('click', () => { this.page--; this.#render(); });
        this.next.addEventListener('click', () => { this.page++; this.#render(); });
        this.nativeCleanup.addEventListener('click', () => void this.#openNativeCleanup());
        this.scanOrphanBackups.addEventListener('click', () => void this.#scanOrphanBackups());
        this.selectAll.addEventListener('click', () => this.#toggleSelectAll());
        this.deleteSelected.addEventListener('click', () => this.#showDelete(Array.from(this.selected.values())));
        required('[data-cm-inventory-viewer-close]', HTMLButtonElement).addEventListener('click', () => this.#closeViewer());
        required('[data-cm-inventory-delete-close]', HTMLButtonElement).addEventListener('click', () => this.#closeDelete());
        this.deleteCancel.addEventListener('click', () => this.#closeDelete());
        this.deleteConfirm.addEventListener('click', () => void this.#executeDelete());
        for (const [mode, button] of this.modes) button.addEventListener('click', () => this.#selectMode(mode));
        for (const [kind, button] of this.tabs) button.addEventListener('click', () => this.#selectKind(kind));
        document.body.append(root);
        this.#syncMode();
    }

    /** 打开独立文件清单并重新读取基础清单 */
    async open() {
        this.#selectMode('all');
        this.root.classList.remove('cm-hidden');
        await this.refresh();
    }

    /** 关闭独立文件清单并释放扫描资源 */
    close() {
        this.scanRevision++;
        this.controller?.abort();
        this.orphanController?.abort();
        this.controller = null;
        this.orphanController = null;
        this.#closeViewer();
        this.#closeDelete();
        this.root.classList.add('cm-hidden');
        void this.#releaseReport();
    }

    /** 重新读取全部可识别聊天与全部原生聊天备份 */
    async refresh() {
        this.scanRevision++;
        this.controller?.abort();
        this.orphanController?.abort();
        this.orphanController = null;
        await this.#releaseReport();
        this.#clearOptionalResults();
        this.selected.clear();
        this.controller = new AbortController();
        const controller = this.controller;
        const signal = this.controller.signal;
        this.scanOrphanBackups.disabled = true;
        const startedAt = Date.now();
        let completed = 0;
        const updateProgress = () => this.#setStatus(`正在读取聊天与备份文件 · ${completed} / 2`, {
            loading: true,
            detail: `已等待 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`,
            done: completed,
            total: 2,
        });
        updateProgress();
        const timer = setInterval(updateProgress, 250);
        const failures = [];
        this.chatInventoryLoaded = false;
        const chats = this.api.listChatFiles(signal).then(data => {
            if (!Array.isArray(data)) throw new Error('聊天文件接口返回格式无效');
            this.items.chats = this.#mapChats(data);
            this.chatInventoryLoaded = true;
            this.#render();
        }).catch(error => {
            if (!signal.aborted) failures.push(`聊天文件：${error.message}`);
        }).finally(() => {
            completed++;
            updateProgress();
        });
        const backups = this.backups.list(signal, true).then(data => {
            if (!Array.isArray(data)) throw new Error('备份文件接口返回格式无效');
            this.items.backups = data.map(item => this.#mapBackup(item));
            this.#render();
        }).catch(error => {
            if (!signal.aborted) failures.push(`备份文件：${error.message}`);
        }).finally(() => {
            completed++;
            updateProgress();
        });
        await Promise.allSettled([chats, backups]);
        clearInterval(timer);
        if (signal.aborted) return;
        this.#setStatus(failures.join('；'), { error: failures.length > 0 });
        if (this.controller === controller) {
            this.scanOrphanBackups.disabled = false;
        }
    }

    /** @param {object[]} data recent 接口数据 */
    #mapChats(data) {
        const context = this.getContext();
        const characters = new Map((context.characters ?? []).map(character => [character.avatar, character]));
        const groups = new Map((context.groups ?? []).map(group => [String(group.id), group]));
        return data.map(item => {
            const isGroup = item.group !== undefined && item.group !== null;
            const owner = isGroup ? groups.get(String(item.group)) : characters.get(item.avatar);
            const fileId = stripJsonl(item.file_id ?? item.file_name);
            const ownerName = String(owner?.name ?? (isGroup ? `群组 ${item.group}` : item.avatar ? `角色 ${item.avatar}` : '根目录聊天'));
            const record = owner ? {
                ownerType: isGroup ? 'group' : 'character',
                ownerId: String(isGroup ? item.group : item.avatar),
                ownerName,
                fileId,
                fileName: String(item.file_name ?? `${fileId}.jsonl`),
                fileSize: String(item.file_size ?? ''),
                messageCount: Number(item.chat_items ?? 0),
                lastMessageAt: item.last_mes ?? '',
                preview: String(item.mes ?? ''),
                chatManager: item.chat_metadata?.chat_manager ?? null,
            } : null;
            return {
                name: String(item.file_name ?? `${fileId}.jsonl`),
                owner: ownerName,
                kind: '聊天',
                size: parseBytes(item.file_size),
                sizeLabel: String(item.file_size ?? '未知大小'),
                timestamp: this.#timeValue(item.last_mes),
                detail: `${Number(item.chat_items ?? 0)} 层 · 最后消息 ${this.#formatDate(item.last_mes)}`,
                integrity: String(item.chat_metadata?.integrity ?? ''),
                record,
            };
        });
    }

    /** @param {object} item 备份接口数据 */
    #mapBackup(item) {
        const timestamp = this.#backupTimestamp(item.file_name) || this.#timeValue(item.last_mes);
        const count = item.chat_items === null || item.chat_items === undefined ? null : Number(item.chat_items);
        return {
            name: String(item.file_name ?? ''),
            owner: '酒馆原生聊天备份',
            kind: '备份',
            size: parseBytes(item.file_size),
            sizeLabel: String(item.file_size ?? '未知大小'),
            timestamp,
            detail: `${Number.isFinite(count) ? `${count} 层` : '消息数待读取'} · 备份时间 ${this.#formatDate(timestamp)}`,
            backup: item,
        };
    }

    /** @param {object} item 数据清理报告条目 */
    #mapOrphan(item, owner) {
        return {
            name: String(item.name ?? ''),
            owner,
            kind: '孤立',
            size: Number(item.size ?? 0),
            sizeLabel: formatBytes(Number(item.size ?? 0)),
            timestamp: Number(item.mtime ?? 0),
            detail: `修改时间 ${this.#formatDate(item.mtime)}`,
            orphan: item,
        };
    }

    /** 检查无法对应现有聊天的原生备份 */
    async #scanOrphanBackups() {
        const revision = ++this.scanRevision;
        this.orphanController?.abort();
        this.orphanController = new AbortController();
        const signal = this.orphanController.signal;
        this.scanOrphanBackups.disabled = true;
        const startedAt = Date.now();
        const updateStatus = () => this.#setStatus('正在生成文件检查报告…', {
            loading: true,
            detail: `已等待 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`,
        });
        updateStatus();
        const timer = setInterval(updateStatus, 250);
        try {
            if (!this.dataMaidReport) {
                const result = await this.backups.getReport(signal);
                if (signal.aborted) {
                    return;
                }
                if (!result?.report || !result.token) throw new Error('酒馆数据清理报告格式无效');
                this.reportToken = result.token;
                this.dataMaidReport = result.report;
                this.reportShared = true;
            }
            clearInterval(timer);
            this.orphanBackupCache ??= await this.#findOrphanBackups(this.dataMaidReport.chatBackups, signal, startedAt);
            this.items.orphanBackups = this.orphanBackupCache;
            this.scanned.orphanBackups = true;
            const found = this.items.orphanBackups.length;
            this.#setStatus(found
                ? `已找到 ${found} 个孤立或待确认备份`
                : '没有发现孤立或待确认备份');
            this.#syncMode();
            this.#selectKind('orphanBackups');
            this.#render();
        } catch (error) {
            if (!signal.aborted) {
                this.#setStatus(error.message, { error: true });
                notify('error', error.message);
            }
        } finally {
            clearInterval(timer);
            if (revision === this.scanRevision) {
                this.scanOrphanBackups.disabled = false;
                this.orphanController = null;
            }
        }
    }

    /** 清除额外检查结果但保留基础聊天与备份清单 */
    #clearOptionalResults() {
        this.items.orphanBackups = [];
        this.scanned.orphanBackups = false;
        this.selected.clear();
        if (this.activeKind === 'orphanBackups') this.activeKind = 'chats';
        this.#syncMode();
    }

    /**
     * 根据稳定完整性标识判断备份是否仍能对应现有聊天
     * @param {object[]} reportBackups 数据清理报告中的全部聊天备份
     * @param {AbortSignal} signal 取消信号
     * @param {number} startedAt 扫描开始时间
     * @returns {Promise<object[]>} 孤立或无法自动确认的备份
     */
    async #findOrphanBackups(reportBackups, signal, startedAt) {
        if (!this.chatInventoryLoaded) throw new Error('现有聊天清单读取失败，无法安全判断孤立备份');
        const candidates = Array.isArray(reportBackups) ? reportBackups : [];
        const activeIntegrities = new Set(this.items.chats.map(item => item.integrity).filter(Boolean));
        const backupByName = new Map(this.items.backups.map(item => [item.name, item]));
        const results = new Array(candidates.length);
        let cursor = 0;
        let done = 0;
        const run = async () => {
            while (cursor < candidates.length) {
                const index = cursor++;
                const item = candidates[index];
                let integrity = '';
                let state = '待确认';
                let reason = '旧备份缺少完整性标识，无法自动确认是否仍有对应聊天';
                try {
                    integrity = await this.#readReportIntegrity(item, signal) ?? '';
                    const classification = classifyBackupIntegrity(integrity, activeIntegrities);
                    if (classification === 'linked') {
                        results[index] = null;
                    } else if (classification === 'orphan') {
                        state = '孤立备份';
                        reason = '完整性标识无法对应任何现有聊天';
                    }
                } catch (error) {
                    if (signal.aborted) throw error;
                    reason = `无法读取备份头部：${error.message}`;
                }
                if (results[index] !== null) {
                    const known = backupByName.get(item.name);
                    results[index] = {
                        ...this.#mapOrphan(item, '酒馆原生聊天备份'),
                        kind: state,
                        backup: known?.backup,
                        detail: `${reason}${known?.backup ? ` · ${Number(known.backup.chat_items ?? 0)} 层` : ''} · 备份时间 ${this.#formatDate(item.mtime)}`,
                    };
                }
                done++;
                this.#setStatus(`正在检查备份对应关系 · ${done} / ${candidates.length}`, {
                    loading: true,
                    detail: `已等待 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`,
                    done,
                    total: candidates.length,
                });
            }
        };
        const workers = Array.from({ length: Math.min(4, candidates.length) }, () => run());
        await Promise.all(workers);
        return results.filter(Boolean);
    }

    /**
     * 直接通过当前数据清理报告读取备份完整性标识，避免再次按文件名枚举备份
     * @param {object} item 报告中的备份条目
     * @param {AbortSignal} signal 取消信号
     * @returns {Promise<string|null>} 完整性标识
     */
    async #readReportIntegrity(item, signal) {
        let integrity = null;
        const response = await this.api.readDataMaidFile(this.reportToken, item.hash, signal);
        await parseJsonlResponse(response, {
            stopAfter: 0,
            onHeader: header => { integrity = header.chat_metadata?.integrity ?? null; },
        });
        return integrity;
    }

    async #releaseReport() {
        const token = this.reportToken;
        const shared = this.reportShared;
        this.reportToken = '';
        this.dataMaidReport = null;
        this.reportShared = false;
        this.orphanBackupCache = null;
        if (!token || shared) return;
        try {
            await this.api.finalizeDataMaidReport(token);
        } catch (error) {
            console.warn('[聊天文件管理] 释放数据清理报告失败', error);
        }
    }

    #selectKind(kind) {
        if (!this.items[kind]) return;
        this.activeKind = kind;
        this.page = 0;
        for (const [key, button] of this.tabs) {
            const active = key === kind;
            button.classList.toggle('cm-active', active);
            button.setAttribute('aria-selected', String(active));
        }
        this.#render();
    }

    /** @param {'all'|'orphan'} mode 一级功能页 */
    #selectMode(mode) {
        if (!this.modes.has(mode)) return;
        this.mode = mode;
        if (mode === 'all') this.activeKind = 'chats';
        else this.activeKind = 'orphanBackups';
        this.page = 0;
        this.#syncMode();
        this.#render();
    }

    /** 同步一级功能页、操作区与二级结果标签 */
    #syncMode() {
        for (const [mode, button] of this.modes) {
            const active = mode === this.mode;
            button.classList.toggle('cm-active', active);
            button.setAttribute('aria-selected', String(active));
        }
        this.orphanActions.classList.toggle('cm-hidden', this.mode !== 'orphan');
        this.refreshButton.classList.toggle('cm-hidden', this.mode !== 'all');
        for (const [kind, button] of this.tabs) {
            const view = button.dataset.cmInventoryView;
            const available = view === this.mode && (view === 'all' || this.scanned[kind]);
            button.classList.toggle('cm-hidden', !available);
            const active = available && kind === this.activeKind;
            button.classList.toggle('cm-active', active);
            button.setAttribute('aria-selected', String(active));
        }
        this.#syncSelection();
    }

    #render() {
        for (const kind of Object.keys(this.counts)) this.counts[kind].textContent = String(this.items[kind].length);
        const filtered = this.#filteredItems();
        const sorted = [...filtered].sort((a, b) => {
            if (this.sort.value === 'largest') return b.size - a.size;
            if (this.sort.value === 'latest') return b.timestamp - a.timestamp;
            return a.timestamp - b.timestamp;
        });
        const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
        this.page = Math.max(0, Math.min(this.page, pages - 1));
        const visible = sorted.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE);
        this.list.replaceChildren(...visible.map(item => this.#row(item)));
        if (!visible.length) {
            const empty = document.createElement('div');
            empty.className = 'cm-state cm-empty-state';
            empty.textContent = this.mode === 'orphan' && !this.scanned.orphanBackups
                ? '点击“检查孤立备份”开始检查'
                : '没有可显示的文件';
            this.list.append(empty);
        }
        const bytes = filtered.reduce((total, item) => total + item.size, 0);
        this.summary.textContent = `${filtered.length} 个文件 · ${formatBytes(bytes)}`;
        this.pageLabel.textContent = `${this.page + 1} / ${pages}`;
        this.previous.disabled = this.page <= 0;
        this.next.disabled = this.page >= pages - 1;
        this.#syncSelection();
    }

    /** @returns {object[]} 当前标签中符合筛选条件的文件 */
    #filteredItems() {
        const query = this.search.value.trim().toLowerCase();
        return this.items[this.activeKind].filter(item => !query || `${item.name} ${item.owner} ${item.detail}`.toLowerCase().includes(query));
    }

    /** @param {object} item 文件清单条目 */
    #row(item) {
        const fragment = this.rowTemplate.content.cloneNode(true);
        const row = fragment.firstElementChild;
        const mount = selector => row.querySelector(selector);
        mount('[data-cm-inventory-name]').textContent = item.name;
        mount('[data-cm-inventory-owner]').textContent = item.owner;
        mount('[data-cm-inventory-facts]').textContent = `${item.sizeLabel} · ${item.detail}`;
        mount('[data-cm-inventory-kind]').textContent = item.kind;
        const icon = mount('[data-cm-inventory-icon]');
        icon.className = item.backup ? 'fa-solid fa-box-archive' : item.orphan ? 'fa-solid fa-link-slash' : 'fa-solid fa-comments';
        const selectWrap = mount('[data-cm-inventory-select-wrap]');
        const select = mount('[data-cm-inventory-select]');
        const view = mount('[data-cm-inventory-view-file]');
        const download = mount('[data-cm-inventory-download]');
        const enter = mount('[data-cm-inventory-enter]');
        const remove = mount('[data-cm-inventory-delete]');
        const selectable = Boolean(item.orphan?.hash);
        selectWrap.classList.toggle('cm-hidden', !selectable);
        select.checked = selectable && this.selected.has(item.orphan.hash);
        select.addEventListener('change', () => {
            if (select.checked) this.selected.set(item.orphan.hash, item);
            else this.selected.delete(item.orphan.hash);
            row.classList.toggle('cm-selected', select.checked);
            this.#syncSelection();
        });
        row.classList.toggle('cm-selected', select.checked);
        view.classList.toggle('cm-hidden', !item.backup && !item.orphan);
        download.classList.toggle('cm-hidden', !item.backup && !item.orphan);
        enter.classList.toggle('cm-hidden', !item.record);
        remove.classList.toggle('cm-hidden', !selectable);
        if (item.backup || item.orphan) view.addEventListener('click', () => void this.#viewItem(item));
        if (item.orphan) download.addEventListener('click', () => void this.#downloadOrphan(item));
        else if (item.backup) download.addEventListener('click', () => void this.backups.download(item.backup));
        if (item.record) {
            enter.addEventListener('click', async () => {
                enter.disabled = true;
                try {
                    await this.openRecord(item.record);
                    this.close();
                } catch (error) {
                    notify('error', error.message);
                    enter.disabled = false;
                }
            });
        }
        if (selectable) remove.addEventListener('click', () => this.#showDelete([item]));
        row.addEventListener('click', event => {
            if (!selectable || event.target.closest('button, label')) return;
            select.checked = !select.checked;
            select.dispatchEvent(new Event('change'));
        });
        return row;
    }

    /** 同步孤立结果选择与批量删除控件 */
    #syncSelection() {
        const selectable = this.mode === 'orphan' && this.activeKind === 'orphanBackups' && this.scanned.orphanBackups;
        this.selection.classList.toggle('cm-hidden', !selectable);
        const current = selectable ? this.#filteredItems().filter(item => item.orphan?.hash) : [];
        const allSelected = current.length > 0 && current.every(item => this.selected.has(item.orphan.hash));
        this.selectAll.disabled = current.length === 0;
        this.selectAll.textContent = allSelected ? '取消全选当前结果' : '全选当前结果';
        this.deleteSelected.disabled = this.selected.size === 0;
        this.selectedCount.textContent = `删除已选（${this.selected.size}）`;
    }

    /** 选择或取消选择当前筛选结果中的全部孤立文件 */
    #toggleSelectAll() {
        const current = this.#filteredItems().filter(item => item.orphan?.hash);
        const allSelected = current.length > 0 && current.every(item => this.selected.has(item.orphan.hash));
        for (const item of current) {
            if (allSelected) this.selected.delete(item.orphan.hash);
            else this.selected.set(item.orphan.hash, item);
        }
        this.#render();
    }

    /** @param {object} item 待查看文件 */
    async #viewItem(item) {
        this.viewerController?.abort();
        this.viewerController = new AbortController();
        const signal = this.viewerController.signal;
        let page = 0;
        const pageSize = 50;
        this.viewer.classList.remove('cm-hidden');
        this.viewerTitle.textContent = `查看内容 · ${item.name}`;
        this.viewerSummary.textContent = `${item.kind} · ${item.owner} · ${item.sizeLabel} · ${item.detail}`;
        const load = async () => {
            this.messages.replaceChildren();
            const loading = document.createElement('div');
            loading.className = 'cm-state';
            loading.textContent = '正在读取该页…';
            this.messages.append(loading);
            this.messagePrevious.disabled = true;
            this.messageNext.disabled = true;
            try {
                const result = await this.#readItemPage(item, page, pageSize, signal);
                if (signal.aborted) return;
                this.messages.replaceChildren(...result.messages.map((message, index) => this.#message(message, page * pageSize + index)));
                if (!result.messages.length) {
                    loading.textContent = '该页没有消息';
                    this.messages.append(loading);
                }
                this.messagePage.textContent = `第 ${page + 1} 页`;
                this.messagePrevious.disabled = page <= 0;
                this.messageNext.disabled = !result.hasMore;
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

    /**
     * @param {object} item 文件条目
     * @param {number} page 页码
     * @param {number} pageSize 每页消息数
     * @param {AbortSignal} signal 取消信号
     * @returns {Promise<{messages:object[],hasMore:boolean}>} 当前页消息与下一页状态
     */
    async #readItemPage(item, page, pageSize, signal) {
        if (item.orphan) {
            if (!this.reportToken) throw new Error('文件检查报告已失效，请重新检查');
            const start = page * pageSize;
            const collected = [];
            const response = await this.api.readDataMaidFile(this.reportToken, item.orphan.hash, signal);
            await parseJsonlResponse(response, {
                stopAfter: start + pageSize + 1,
                onMessage: (message, index) => {
                    if (index >= start && index <= start + pageSize) collected.push(message);
                },
            });
            return { messages: collected.slice(0, pageSize), hasMore: collected.length > pageSize };
        }
        if (!item.backup) throw new Error('该文件当前无法读取');
        const messages = await this.backups.readPage(item.backup, page, pageSize, signal);
        const total = Number(item.backup.chat_items);
        return { messages, hasMore: Number.isFinite(total) ? (page + 1) * pageSize < total : messages.length === pageSize };
    }

    /**
     * @param {object} message 聊天消息
     * @param {number} index 楼层
     * @returns {HTMLElement} 消息卡片
     */
    #message(message, index) {
        const fragment = this.messageTemplate.content.cloneNode(true);
        const row = fragment.firstElementChild;
        row.querySelector('[data-cm-message-name]').textContent = `#${index} ${message.name ?? ''}`;
        row.querySelector('[data-cm-message-date]').textContent = this.#formatDate(message.send_date);
        row.querySelector('[data-cm-message-content]').textContent = String(message.mes ?? '');
        return row;
    }

    #closeViewer() {
        this.viewerController?.abort();
        this.viewerController = null;
        this.viewer?.classList.add('cm-hidden');
    }

    /** @param {object[]} items 待确认删除的孤立文件 */
    #showDelete(items) {
        const unique = Array.from(new Map(items.filter(item => item.orphan?.hash).map(item => [item.orphan.hash, item])).values());
        if (!unique.length) return;
        this.pendingDelete = unique;
        this.deleteList.replaceChildren(...unique.map(item => {
            const fragment = this.deleteTemplate.content.cloneNode(true);
            const row = fragment.firstElementChild;
            row.dataset.hash = item.orphan.hash;
            row.querySelector('[data-cm-delete-name]').textContent = item.name;
            row.querySelector('[data-cm-delete-kind]').textContent = `${item.kind} · ${item.owner}`;
            row.querySelector('[data-cm-delete-facts]').textContent = `${item.sizeLabel} · ${item.detail}`;
            return row;
        }));
        const bytes = unique.reduce((total, item) => total + item.size, 0);
        const uncertain = unique.filter(item => item.kind === '待确认').length;
        this.deleteSummary.textContent = `${unique.length} 个文件 · ${formatBytes(bytes)}${uncertain ? ` · 其中 ${uncertain} 个备份待确认` : ''}`;
        this.deleteConfirm.classList.remove('cm-hidden');
        this.deleteConfirm.disabled = false;
        this.deleteCancel.disabled = false;
        this.deleteCancel.textContent = '取消';
        this.deleteDialog.classList.remove('cm-hidden');
    }

    async #executeDelete() {
        if (!this.reportToken || !this.pendingDelete.length) return;
        const items = [...this.pendingDelete];
        this.deleteConfirm.disabled = true;
        this.deleteCancel.disabled = true;
        for (const row of this.deleteList.children) {
            const status = row.querySelector('[data-cm-delete-status]');
            status.textContent = '正在删除';
            status.dataset.state = 'loading';
        }
        try {
            await this.api.deleteDataMaidFiles(this.reportToken, items.map(item => item.orphan.hash));
            const hashes = new Set(items.map(item => item.orphan.hash));
            const names = new Set(items.map(item => item.name));
            this.items.orphanBackups = this.items.orphanBackups.filter(item => !hashes.has(item.orphan?.hash));
            this.items.backups = this.items.backups.filter(item => !names.has(item.name));
            this.backups.forget(names);
            if (this.orphanBackupCache) this.orphanBackupCache = this.orphanBackupCache.filter(item => !hashes.has(item.orphan?.hash));
            for (const hash of hashes) this.selected.delete(hash);
            for (const row of this.deleteList.children) {
                const status = row.querySelector('[data-cm-delete-status]');
                status.textContent = '已删除';
                status.dataset.state = 'ready';
            }
            this.deleteSummary.textContent = `已删除 ${items.length} 个文件`;
            this.deleteConfirm.classList.add('cm-hidden');
            this.deleteCancel.disabled = false;
            this.deleteCancel.textContent = '关闭';
            this.pendingDelete = [];
            this.#render();
            notify('success', `已删除 ${items.length} 个孤立文件`);
        } catch (error) {
            for (const row of this.deleteList.children) {
                const status = row.querySelector('[data-cm-delete-status]');
                status.textContent = '删除失败';
                status.dataset.state = 'error';
            }
            this.deleteSummary.textContent = `删除失败：${error.message}`;
            this.deleteCancel.disabled = false;
            notify('error', error.message);
        }
    }

    #closeDelete() {
        if (this.deleteConfirm?.disabled && this.deleteCancel?.disabled) return;
        this.pendingDelete = [];
        this.deleteDialog?.classList.add('cm-hidden');
    }

    /** @param {object} item 孤立聊天条目 */
    async #downloadOrphan(item) {
        try {
            const response = await this.api.readDataMaidFile(this.reportToken, item.orphan.hash);
            const url = URL.createObjectURL(await response.blob());
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = item.name;
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 0);
        } catch (error) {
            notify('error', error.message);
        }
    }

    /** 关闭插件面板并打开酒馆原生数据清理面板 */
    async #openNativeCleanup() {
        const button = document.querySelector('#data_maid_button');
        if (!(button instanceof HTMLElement)) {
            notify('error', '当前酒馆版本没有可用的数据清理入口');
            return;
        }
        this.close();
        await this.backups.dispose();
        button.click();
    }

    #setStatus(message, { loading = false, error = false, detail = '', done = null, total = null } = {}) {
        this.statusText.textContent = message;
        this.statusDetail.textContent = detail;
        this.status.classList.toggle('cm-hidden', !message);
        this.status.classList.toggle('cm-error', error);
        this.spinner.classList.toggle('cm-hidden', !loading);
        this.progress.classList.toggle('cm-hidden', !loading);
        const determinate = loading && Number.isFinite(done) && Number.isFinite(total) && total > 0;
        this.progress.classList.toggle('cm-loading-progress-indeterminate', loading && !determinate);
        if (determinate) {
            this.progress.setAttribute('aria-valuemin', '0');
            this.progress.setAttribute('aria-valuemax', String(total));
            this.progress.setAttribute('aria-valuenow', String(done));
            this.progressValue.style.width = `${Math.min(100, (done / total) * 100)}%`;
        } else {
            this.progress.removeAttribute('aria-valuemin');
            this.progress.removeAttribute('aria-valuemax');
            this.progress.removeAttribute('aria-valuenow');
            this.progressValue.style.width = '';
        }
    }

    #backupTimestamp(name) {
        const match = String(name ?? '').match(/_(\d{8})-(\d{6})\.jsonl$/i);
        if (!match) return 0;
        const date = match[1];
        const time = match[2];
        return new Date(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)), Number(time.slice(0, 2)), Number(time.slice(2, 4)), Number(time.slice(4, 6))).valueOf();
    }

    #timeValue(value) {
        const time = new Date(value ?? 0).valueOf();
        return Number.isFinite(time) ? time : 0;
    }

    #formatDate(value) {
        const time = typeof value === 'number' ? value : this.#timeValue(value);
        if (!time) return '未知时间';
        return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(time));
    }
}
