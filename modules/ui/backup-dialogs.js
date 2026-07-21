import { power_user } from '/scripts/power-user.js';

const BACKUP_STATUS = {
    pending: { label: '等待检查', state: 'loading' },
    matched: { label: '完整匹配', state: 'ready' },
    confirm: { label: '部分相关', state: 'warning' },
    error: { label: '读取异常', state: 'error' },
};

/**
 * 管理备份扫描以及聊天和备份的只读查看弹窗
 */
export class BackupDialogs {
    /**
     * @param {object} options 依赖项
     * @param {import('./templates.js').UiTemplates} options.ui UI 模板工具
     * @param {import('../api.js').ChatManagerApi} options.api 酒馆接口
     * @param {import('../backups.js').BackupService} options.backups 备份服务
     * @param {()=>boolean} options.isGenerating 是否正在生成
     * @param {()=>boolean} options.isSplitting 是否正在分卷
     * @param {(record:object,backup:object)=>Promise<string[]>} options.restoreBackup 恢复备份
     * @param {()=>void} options.closePanel 关闭主面板
     * @param {(type:string,message:string)=>void} options.notify 消息提示
     */
    constructor({ ui, api, backups, isGenerating, isSplitting, restoreBackup, closePanel, notify }) {
        Object.assign(this, { ui, api, backups, isGenerating, isSplitting, restoreBackup, closePanel, notify });
    }

    /**
     * 打开对应备份弹窗
     * @param {object} record 原聊天记录
     */
    async open(record) {
        if (this.isGenerating()) return this.notify('warning', '聊天正在生成，结束后才能读取备份');
        if (this.isSplitting()) return this.notify('warning', '分割任务正在写入聊天，完成后才能读取备份');
        const dialog = this.ui.dialog(['对应备份', record.ownerName, record.fileId], 'backups');
        const search = this.ui.mount(dialog.body, '[data-cm-backup-search]', HTMLInputElement);
        const sort = this.ui.mount(dialog.body, '[data-cm-backup-sort]', HTMLSelectElement);
        const status = this.ui.mount(dialog.body, '[data-cm-backup-status]');
        const statusText = this.ui.mount(dialog.body, '[data-cm-backup-status-text]');
        const elapsed = this.ui.mount(dialog.body, '[data-cm-backup-elapsed]');
        const progress = this.ui.mount(dialog.body, '[data-cm-backup-progress]');
        const progressValue = this.ui.mount(dialog.body, '[data-cm-backup-progress-value]');
        const summary = this.ui.mount(dialog.body, '[data-cm-backup-summary]');
        const results = this.ui.mount(dialog.body, '[data-cm-backup-results]');
        const startedAt = Date.now();
        const timer = setInterval(() => {
            elapsed.textContent = `已等待 ${((Date.now() - startedAt) / 1_000).toFixed(1)} 秒`;
        }, 250);
        const stopLoading = () => clearInterval(timer);
        dialog.signal.addEventListener('abort', stopLoading, { once: true });
        let found = 0;
        let checked = 0;
        let candidateCount = 0;
        const rows = new Map();
        let complete = false;
        const applyView = () => {
            const query = search.value.trim().toLowerCase();
            const entries = Array.from(rows.values()).sort((left, right) => {
                if (sort.value === 'oldest') return Number(left.backup.last_mes ?? 0) - Number(right.backup.last_mes ?? 0);
                if (sort.value === 'largest') return Number(right.backup.file_bytes ?? 0) - Number(left.backup.file_bytes ?? 0);
                return Number(right.backup.last_mes ?? 0) - Number(left.backup.last_mes ?? 0);
            });
            let visible = 0;
            for (const entry of entries) {
                const haystack = `${entry.backup.file_name} ${entry.backup.reason ?? ''} ${entry.backup.mes ?? ''}`.toLowerCase();
                const matches = !query || haystack.includes(query);
                entry.row.classList.toggle('cm-hidden', !matches);
                if (matches) visible++;
                results.append(entry.row);
            }
            return visible;
        };
        const refreshSummary = () => {
            const visible = applyView();
            summary.textContent = complete
                ? `显示 ${visible} / ${rows.size} 个备份 · 原聊天 ${record.fileSize} · ${record.messageCount} 层`
                : `候选 ${candidateCount} 个 · 已检查 ${checked} 个 · 已确认 ${found} 个`;
            summary.classList.remove('cm-hidden');
        };
        search.addEventListener('input', refreshSummary);
        sort.addEventListener('change', refreshSummary);
        try {
            const matches = await this.backups.find(record, {
                onCandidates: candidates => {
                    candidateCount = candidates.length;
                    statusText.textContent = candidates.length ? '备份列表已载入，正在检查文件内容…' : '备份列表已载入';
                    for (const candidate of candidates) {
                        const backup = { ...candidate, status: 'pending', reason: '等待读取并匹配' };
                        const row = this.#row(record, backup, () => {
                            dialog.close();
                            this.closePanel();
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
                    this.#updateRow(entry.row, record, entry.backup);
                    refreshSummary();
                },
            }, dialog.signal);
            stopLoading();
            status.remove();
            complete = true;
            refreshSummary();
            if (!matches.length) results.append(this.ui.state('没有找到能够关联到该聊天的备份', { empty: true }));
        } catch (error) {
            if (dialog.signal.aborted) return;
            stopLoading();
            for (const { row, backup } of rows.values()) {
                if (backup.status !== 'pending') continue;
                backup.status = 'error';
                backup.reason = `扫描中断：${error.message}`;
                this.#updateRow(row, record, backup);
            }
            status.replaceWith(this.ui.state(error.message, { error: true }));
            this.notify('error', error.message);
        }
    }

    /**
     * 查看聊天内容
     * @param {object} record 待查看聊天
     */
    async viewChat(record) {
        let messagesTask;
        const readPage = async (page, pageSize, signal) => {
            messagesTask ??= (record.ownerType === 'character'
                ? this.api.getCharacterChat(record.ownerId, record.fileId, signal)
                : this.api.getGroupChat(record.fileId, signal))
                .then(data => {
                    if (!Array.isArray(data) || data.length < 1) throw new Error('聊天内容为空或不存在');
                    return data.slice(1);
                });
            const messages = await messagesTask;
            return messages.slice(page * pageSize, (page + 1) * pageSize);
        };
        await this.#viewMessages(['查看聊天', record.ownerName, record.fileId], Number(record.messageCount), readPage);
    }

    #row(record, backup, onRestored) {
        const row = this.ui.component('backup-row');
        this.#updateRow(row, record, backup);
        const restore = this.ui.mount(row, '[data-cm-backup-restore]', HTMLButtonElement);
        this.ui.bindButton(restore, async () => {
            if (!['matched', 'confirm'].includes(backup.status)) return;
            restore.disabled = true;
            try {
                await this.restoreBackup(record, backup);
                this.notify('success', '备份已恢复为一份新聊天');
                onRestored();
            } finally {
                restore.disabled = !['matched', 'confirm'].includes(backup.status);
            }
        });
        this.ui.bindButton(this.ui.mount(row, '[data-cm-backup-view]', HTMLButtonElement), () => this.#viewBackup(backup));
        this.ui.bindButton(this.ui.mount(row, '[data-cm-backup-download]', HTMLButtonElement), () => this.backups.download(backup));
        return row;
    }

    #updateRow(row, record, backup) {
        this.ui.mount(row, '[data-cm-backup-name]').textContent = backup.file_name;
        const status = this.ui.mount(row, '[data-cm-backup-status]');
        const statusView = BACKUP_STATUS[backup.status] ?? BACKUP_STATUS.error;
        status.textContent = statusView.label;
        status.dataset.state = statusView.state;
        this.ui.mount(row, '[data-cm-backup-created]').textContent = this.ui.formatBackupDate(backup.file_name);
        this.ui.mount(row, '[data-cm-backup-last-message]').textContent = this.ui.formatDate(backup.last_mes);
        this.ui.mount(row, '[data-cm-backup-size]').textContent = `${backup.file_size} · ${backup.chat_items ?? '未知'} 层`;
        this.ui.mount(row, '[data-cm-backup-reason]').textContent = `匹配依据：${backup.reason ?? '未提供'}`;
        this.ui.mount(row, '[data-cm-backup-preview]').textContent = String(backup.mes ?? '没有可显示的最后消息');
        this.ui.mount(row, '[data-cm-backup-restore]', HTMLButtonElement).disabled = !['matched', 'confirm'].includes(backup.status);
    }

    async #viewBackup(backup) {
        await this.#viewMessages(
            `查看备份 · ${backup.file_name}`,
            Number(backup.chat_items),
            (page, pageSize, signal) => this.backups.readPage(backup, page, pageSize, signal),
        );
    }

    async #viewMessages(title, total, readPage) {
        const dialog = this.ui.dialog(title, 'backup-viewer');
        const pageSize = Number(power_user.chat_truncation) || Number.MAX_SAFE_INTEGER;
        const pages = Number.isFinite(total) ? Math.max(1, Math.ceil(total / pageSize)) : null;
        let page = pages ? pages - 1 : 0;
        const content = this.ui.mount(dialog.body, '[data-cm-message-list]');
        const previous = this.ui.mount(dialog.body, '[data-cm-message-previous]', HTMLButtonElement);
        const label = this.ui.mount(dialog.body, '[data-cm-message-page]');
        const next = this.ui.mount(dialog.body, '[data-cm-message-next]', HTMLButtonElement);
        const load = async () => {
            content.replaceChildren(this.ui.state('正在读取该页…'));
            try {
                const messages = await readPage(page, pageSize, dialog.signal);
                content.replaceChildren();
                messages.forEach((message, index) => {
                    const item = this.ui.component('message');
                    this.ui.mount(item, '[data-cm-message-name]').textContent = `#${page * pageSize + index} ${message.name ?? ''}`;
                    this.ui.mount(item, '[data-cm-message-date]', HTMLTimeElement).textContent = this.ui.formatDate(message.send_date);
                    this.ui.mount(item, '[data-cm-message-content]').textContent = String(message.mes ?? '');
                    content.append(item);
                });
                label.textContent = pages ? `${page + 1} / ${pages}` : `第 ${page + 1} 页`;
                previous.disabled = page <= 0;
                next.disabled = pages ? page >= pages - 1 : messages.length < pageSize;
            } catch (error) {
                if (!dialog.signal.aborted) content.replaceChildren(this.ui.state(error.message, { error: true }));
            }
        };
        this.ui.bindButton(previous, () => { page--; return load(); });
        this.ui.bindButton(next, () => { page++; return load(); });
        await load();
    }
}
