import { chatKey, element, formatBytes, stripJsonl } from './utils.js';
import { describePart } from './splitter.js';

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
     */
    constructor({ getContext, api, backups, splitter, isGenerating, openRecord }) {
        this.getContext = getContext;
        this.api = api;
        this.backups = backups;
        this.splitter = splitter;
        this.isGenerating = isGenerating;
        this.openRecord = openRecord;
        this.records = null;
        this.filtered = [];
        this.page = 0;
        this.selectedKey = null;
        this.loading = false;
        this.#build();
    }

    #build() {
        this.root = element('div', { className: 'cm-overlay cm-hidden', attrs: { id: 'chat_manager_overlay' } });
        const panel = element('section', { className: 'cm-panel' });
        const header = element('header', { className: 'cm-header' });
        header.append(element('h2', { text: '聊天管理' }));
        const close = element('button', { className: 'cm-icon-button', text: '×', title: '关闭', type: 'button' });
        close.addEventListener('click', () => this.close());
        header.append(close);

        const toolbar = element('div', { className: 'cm-toolbar' });
        this.search = element('input', { className: 'text_pole cm-search', attrs: { placeholder: '筛选角色、群组或聊天文件名' } });
        this.search.addEventListener('input', () => { this.page = 0; this.#filter(); });
        const refresh = element('button', { className: 'menu_button', text: '刷新', type: 'button' });
        refresh.addEventListener('click', () => this.refresh());
        toolbar.append(this.search, refresh);

        this.state = element('div', { className: 'cm-state' });
        this.list = element('div', { className: 'cm-chat-list' });
        const footer = element('footer', { className: 'cm-footer' });
        this.previous = element('button', { className: 'menu_button', text: '上一页', type: 'button' });
        this.next = element('button', { className: 'menu_button', text: '下一页', type: 'button' });
        this.pageLabel = element('span');
        this.previous.addEventListener('click', () => { this.page--; this.#render(); });
        this.next.addEventListener('click', () => { this.page++; this.#render(); });
        footer.append(this.previous, this.pageLabel, this.next);
        panel.append(header, toolbar, this.state, this.list, footer);
        this.root.append(panel);
        this.root.addEventListener('mousedown', event => {
            if (event.target === this.root) this.close();
        });
        document.body.append(this.root);
    }

    async open() {
        this.root.classList.remove('cm-hidden');
        this.updateRuntimeState();
        if (!this.records) await this.refresh();
    }

    close() {
        this.root.classList.add('cm-hidden');
    }

    updateRuntimeState() {
        const generating = this.isGenerating();
        this.state.textContent = generating
            ? '聊天正在生成：当前仅允许浏览和查看备份'
            : this.splitter.running ? '分割任务正在执行' : '';
        if (this.activeSplitRoot?.isConnected) this.activeSplitSync?.();
        this.#render();
    }

    async refresh() {
        if (this.loading) return;
        this.loading = true;
        this.state.textContent = '正在读取全部聊天…';
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
                return {
                    ownerType: isGroup ? 'group' : 'character',
                    ownerId: String(isGroup ? item.group : item.avatar),
                    ownerName: String(owner.name ?? item.char_name ?? item.group ?? item.avatar),
                    fileId: stripJsonl(item.file_id ?? item.file_name),
                    fileName: String(item.file_name ?? `${item.file_id}.jsonl`),
                    fileSize: String(item.file_size ?? ''),
                    messageCount: Number(item.chat_items ?? 0),
                    lastMessageAt: item.last_mes ?? '',
                    preview: String(item.mes ?? ''),
                };
            }).filter(Boolean).sort((a, b) => new Date(b.lastMessageAt).valueOf() - new Date(a.lastMessageAt).valueOf());
            this.page = 0;
            this.#filter();
        } catch (error) {
            this.state.textContent = error.message;
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
        const totalPages = Math.max(1, Math.ceil(this.filtered.length / PAGE_SIZE));
        this.page = Math.max(0, Math.min(this.page, totalPages - 1));
        const pageRecords = this.filtered.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE);
        for (const record of pageRecords) this.list.append(this.#chatRow(record));
        if (!pageRecords.length && !this.loading) this.list.append(element('div', { className: 'cm-empty', text: '没有可显示的聊天' }));
        this.pageLabel.textContent = `${this.page + 1} / ${totalPages}（${this.filtered.length}）`;
        this.previous.disabled = this.page <= 0;
        this.next.disabled = this.page >= totalPages - 1;
    }

    #chatRow(record) {
        const row = element('article', { className: `cm-chat-row${this.selectedKey === chatKey(record) ? ' cm-selected' : ''}` });
        const info = element('div', { className: 'cm-chat-info' });
        info.append(
            element('strong', { text: record.ownerName }),
            element('span', { className: 'cm-file-name', text: record.fileId }),
            element('small', { text: `${record.fileSize} · ${record.messageCount} 层 · ${this.#formatDate(record.lastMessageAt)}` }),
            element('p', { text: record.preview }),
        );
        const actions = element('div', { className: 'cm-actions' });
        const open = this.#button('打开', async () => {
            this.selectedKey = chatKey(record);
            this.#render();
            await this.openRecord(record);
            this.close();
        });
        const backup = this.#button('备份', () => this.openBackups(record));
        const split = this.#button('分割', () => this.openSplit(record));
        open.disabled = this.isGenerating() || this.splitter.running;
        split.disabled = this.isGenerating() || this.splitter.running || record.messageCount < 1;
        actions.append(open, backup, split);
        row.addEventListener('click', event => {
            if (event.target.closest('button')) return;
            this.selectedKey = chatKey(record);
            this.#render();
        });
        row.append(info, actions);
        return row;
    }

    async openBackups(record) {
        const dialog = this.#dialog(`对应备份 · ${record.ownerName} / ${record.fileId}`);
        const status = element('div', { className: 'cm-state', text: '正在读取并匹配备份…' });
        dialog.body.append(status);
        try {
            const matches = await this.backups.find(record, (done, total) => {
                status.textContent = `正在匹配备份 ${done}/${total}`;
            }, dialog.signal);
            dialog.body.replaceChildren();
            if (!matches.length) {
                dialog.body.append(element('div', { className: 'cm-empty', text: '没有找到能够关联到该聊天的备份' }));
                return;
            }
            for (const backup of matches) {
                const row = element('article', { className: 'cm-backup-row' });
                const info = element('div', { className: 'cm-chat-info' });
                info.append(
                    element('strong', { text: backup.file_name }),
                    element('small', { text: `${backup.file_size} · ${backup.chat_items} 层 · ${backup.status === 'matched' ? '已匹配' : backup.status === 'confirm' ? '需要确认' : '读取失败'}` }),
                    element('span', { text: backup.reason ?? '' }),
                );
                const actions = element('div', { className: 'cm-actions' });
                actions.append(
                    this.#button('查看', () => this.#viewBackup(backup)),
                    this.#button('下载', () => this.backups.download(backup.file_name)),
                );
                row.append(info, actions);
                dialog.body.append(row);
            }
        } catch (error) {
            if (dialog.signal.aborted) return;
            status.textContent = error.message;
            notify('error', error.message);
        }
    }

    async #viewBackup(backup) {
        const dialog = this.#dialog(`查看备份 · ${backup.file_name}`);
        let page = 0;
        const pageSize = 50;
        const content = element('div', { className: 'cm-message-list' });
        const controls = element('div', { className: 'cm-footer' });
        const previous = this.#button('上一页', () => { page--; load(); });
        const label = element('span');
        const next = this.#button('下一页', () => { page++; load(); });
        controls.append(previous, label, next);
        dialog.body.append(content, controls);
        const load = async () => {
            content.replaceChildren(element('div', { className: 'cm-state', text: '正在读取该页…' }));
            try {
                const messages = await this.backups.readPage(backup.file_name, page, pageSize, dialog.signal);
                content.replaceChildren();
                messages.forEach((message, index) => {
                    const item = element('article', { className: 'cm-message' });
                    item.append(
                        element('strong', { text: `#${page * pageSize + index} ${message.name ?? ''}` }),
                        element('small', { text: this.#formatDate(message.send_date) }),
                        element('pre', { text: String(message.mes ?? '') }),
                    );
                    content.append(item);
                });
                const pages = Math.max(1, Math.ceil(Number(backup.chat_items ?? 0) / pageSize));
                label.textContent = `${page + 1} / ${pages}`;
                previous.disabled = page <= 0;
                next.disabled = page >= pages - 1;
            } catch (error) {
                if (dialog.signal.aborted) return;
                content.replaceChildren(element('div', { className: 'cm-state cm-error', text: error.message }));
            }
        };
        await load();
    }

    async openSplit(record) {
        if (this.isGenerating()) return notify('warning', '聊天正在生成，当前不能分割');
        this.activeSplitClose?.();
        const dialog = this.#dialog(`分割聊天 · ${record.ownerName} / ${record.fileId}`);
        this.activeSplitRoot = dialog.root;
        this.activeSplitClose = dialog.close;
        const form = element('div', { className: 'cm-split-form' });
        const mode = element('select', { className: 'text_pole' });
        mode.append(new Option('指定范围', 'range'), new Option('固定楼层数', 'fixed'));
        const start = this.#numberInput(0, 0, Math.max(0, record.messageCount - 1));
        const end = this.#numberInput(Math.max(0, record.messageCount - 1), 0, Math.max(0, record.messageCount - 1));
        const chunk = this.#numberInput(500, 1, Math.max(1, record.messageCount));
        const chunkRow = this.#field('每卷楼层数', chunk);
        chunkRow.classList.add('cm-hidden');
        mode.addEventListener('change', () => chunkRow.classList.toggle('cm-hidden', mode.value !== 'fixed'));
        form.append(
            element('div', { className: 'cm-source-summary', text: `${record.fileSize} · ${record.messageCount} 层` }),
            this.#field('模式', mode),
            this.#field('起始楼层 #', start),
            this.#field('结束楼层 #', end),
            chunkRow,
        );
        const preview = element('div', { className: 'cm-preview' });
        const notice = element('label', { className: 'cm-confirm-notice' });
        const acknowledge = element('input');
        acknowledge.type = 'checkbox';
        notice.append(acknowledge, document.createTextNode(' 我了解：创建分卷会触发酒馆原生备份及轮换规则'));
        notice.classList.add('cm-hidden');
        const actions = element('div', { className: 'cm-dialog-actions' });
        const generate = this.#button('生成预览', async () => {
            if (this.isGenerating()) return notify('warning', '聊天正在生成，不能生成预览');
            busy = true;
            syncControls();
            preview.replaceChildren(element('div', { className: 'cm-state', text: '正在读取原聊天并计算预览…' }));
            try {
                plan = await this.splitter.prepare(record, {
                    mode: mode.value,
                    start: Number(start.value),
                    end: Number(end.value),
                    chunkSize: Number(chunk.value),
                }, dialog.signal);
                preview.replaceChildren();
                plan.parts.forEach(part => preview.append(element('div', { className: 'cm-preview-row', text: describePart(part) })));
                notice.classList.remove('cm-hidden');
                syncControls();
            } catch (error) {
                plan = null;
                if (dialog.signal.aborted) return;
                preview.replaceChildren(element('div', { className: 'cm-state cm-error', text: error.message }));
                notice.classList.add('cm-hidden');
                syncControls();
            } finally {
                busy = false;
                syncControls();
            }
        });
        const confirm = this.#button('确认分割', async () => {
            if (!plan || !acknowledge.checked) return;
            if (this.isGenerating()) return notify('warning', '聊天正在生成，不能写入分卷');
            busy = true;
            syncControls();
            stop.classList.remove('cm-hidden');
            dialog.setClosable(false);
            try {
                const task = await this.splitter.execute(plan, {
                    shouldPause: () => this.isGenerating(),
                    onUpdate: current => this.#renderTask(preview, current),
                });
                this.#renderTask(preview, task);
                notify(task.status === 'complete' ? 'success' : 'warning', task.status === 'complete' ? '分割完成' : '任务已安全暂停');
                await this.refresh();
            } catch (error) {
                notify('error', error.message);
                if (error.task) this.#renderTask(preview, error.task);
            } finally {
                dialog.setClosable(true);
                stop.classList.add('cm-hidden');
                busy = false;
                syncControls();
            }
        });
        const stop = this.#button('完成当前卷后停止', () => this.splitter.requestStop());
        stop.classList.add('cm-hidden');
        acknowledge.addEventListener('change', () => syncControls());
        for (const input of [mode, start, end, chunk]) input.addEventListener('change', () => {
            plan = null;
            preview.replaceChildren();
            notice.classList.add('cm-hidden');
            syncControls();
        });
        let plan = null;
        let busy = false;
        const syncControls = () => {
            const blocked = busy || this.isGenerating() || this.splitter.running;
            generate.disabled = blocked;
            confirm.disabled = blocked || !plan || !acknowledge.checked;
        };
        this.activeSplitSync = syncControls;
        syncControls();
        actions.append(generate, confirm, stop);
        dialog.body.append(form, preview, notice, actions);
    }

    async showRecovery(tasks) {
        if (!tasks.length) return;
        const dialog = this.#dialog('检测到未完成的分割任务');
        for (const task of tasks) {
            const card = element('article', { className: 'cm-recovery' });
            const details = element('div', { className: 'cm-chat-info' });
            details.append(
                element('strong', { text: `${task.record.ownerName} / ${task.record.fileId}` }),
                element('span', { text: task.parts.map(part => `${part.fileId}：${part.status}`).join('；') }),
            );
            const actions = element('div', { className: 'cm-actions' });
            const resume = this.#button('继续', async () => {
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
            const clear = this.#button('仅清除记录', async () => {
                await this.splitter.journal.remove(task.id);
                card.remove();
            });
            actions.append(resume, clear);
            card.append(details, actions);
            dialog.body.append(card);
        }
    }

    #renderTask(container, task) {
        container.replaceChildren();
        task.parts.forEach(part => container.append(element('div', {
            className: `cm-preview-row cm-status-${part.status}`,
            text: `${part.fileId}　${part.status}${part.error ? `：${part.error}` : ''}`,
        })));
    }

    #dialog(title) {
        const controller = new AbortController();
        const root = element('div', { className: 'cm-overlay cm-dialog-overlay' });
        const panel = element('section', { className: 'cm-dialog' });
        const header = element('header', { className: 'cm-header' });
        header.append(element('h3', { text: title }));
        const remove = () => {
            controller.abort();
            root.remove();
        };
        const close = this.#button('×', remove, '关闭');
        close.className = 'cm-icon-button';
        header.append(close);
        const body = element('div', { className: 'cm-dialog-body' });
        panel.append(header, body);
        root.append(panel);
        root.addEventListener('mousedown', event => {
            if (event.target === root && !close.disabled) remove();
        });
        document.body.append(root);
        return { root, body, signal: controller.signal, close: remove, setClosable: value => { close.disabled = !value; } };
    }

    #button(text, handler, title = '') {
        const button = element('button', { className: 'menu_button', text, title, type: 'button' });
        button.addEventListener('click', event => {
            event.stopPropagation();
            Promise.resolve(handler(event)).catch(error => {
                console.error(error);
                notify('error', error.message);
            });
        });
        return button;
    }

    #field(label, control) {
        const field = element('label', { className: 'cm-field' });
        field.append(element('span', { text: label }), control);
        return field;
    }

    #numberInput(value, min, max) {
        const input = element('input', { className: 'text_pole' });
        input.type = 'number';
        input.value = String(value);
        input.min = String(min);
        input.max = String(max);
        input.step = '1';
        return input;
    }

    #formatDate(value) {
        const date = new Date(value);
        return Number.isNaN(date.valueOf()) ? String(value ?? '') : date.toLocaleString();
    }
}
