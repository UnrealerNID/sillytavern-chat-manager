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
     * @param {string} dependencies.template 稳定面板模板
     * @param {string} dependencies.dialogTemplates 弹窗模板注册表
     * @param {string} dependencies.componentTemplates 重复内容组件模板注册表
     * @param {(record:object)=>string} dependencies.getAvatarUrl 头像地址生成器
     */
    constructor({ getContext, api, backups, splitter, isGenerating, openRecord, template, dialogTemplates, componentTemplates, getAvatarUrl }) {
        this.getContext = getContext;
        this.api = api;
        this.backups = backups;
        this.splitter = splitter;
        this.isGenerating = isGenerating;
        this.openRecord = openRecord;
        this.getAvatarUrl = getAvatarUrl;
        this.records = null;
        this.filtered = [];
        this.page = 0;
        this.selectedKey = null;
        this.loading = false;
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
        this.search.addEventListener('input', () => { this.page = 0; this.#filter(); });
        this.previous.addEventListener('click', () => { this.page--; this.#render(); });
        this.next.addEventListener('click', () => { this.page++; this.#render(); });
        this.root.addEventListener('mousedown', event => {
            if (event.target === this.root) this.close();
        });
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
        const totalPages = Math.max(1, Math.ceil(this.filtered.length / PAGE_SIZE));
        this.page = Math.max(0, Math.min(this.page, totalPages - 1));
        const pageRecords = this.filtered.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE);
        for (const record of pageRecords) this.list.append(this.#chatRow(record));
        if (!pageRecords.length && !this.loading) this.list.append(this.#state('没有可显示的聊天', { empty: true }));
        this.pageLabel.textContent = `第 ${this.page + 1} / ${totalPages} 页 · ${this.filtered.length} 条`;
        this.previous.disabled = this.page <= 0;
        this.next.disabled = this.page >= totalPages - 1;
    }

    #chatRow(record) {
        const row = this.#component('chat-row');
        const image = this.#mount(row, '[data-cm-chat-avatar]', HTMLImageElement);
        const name = this.#mount(row, '[data-cm-chat-name]');
        const owner = this.#mount(row, '[data-cm-chat-owner]');
        const file = this.#mount(row, '[data-cm-chat-file]');
        const date = this.#mount(row, '[data-cm-chat-date]', HTMLTimeElement);
        const preview = this.#mount(row, '[data-cm-chat-preview]');
        const countWrap = this.#mount(row, '[data-cm-chat-count-wrap]');
        const count = this.#mount(row, '[data-cm-chat-count]');
        const size = this.#mount(row, '[data-cm-chat-size]');
        const open = this.#mount(row, '[data-cm-chat-open]', HTMLButtonElement);
        const backup = this.#mount(row, '[data-cm-chat-backups]', HTMLButtonElement);
        const split = this.#mount(row, '[data-cm-chat-split]', HTMLButtonElement);
        row.classList.toggle('cm-selected', this.selectedKey === chatKey(record));
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
        const results = this.#mount(dialog.body, '[data-cm-backup-results]');
        const startedAt = Date.now();
        const updateElapsed = () => {
            elapsed.textContent = `已等待 ${((Date.now() - startedAt) / 1_000).toFixed(1)} 秒`;
        };
        const timer = setInterval(updateElapsed, 250);
        const stopLoading = () => clearInterval(timer);
        dialog.signal.addEventListener('abort', stopLoading, { once: true });
        try {
            const matches = await this.backups.find(record, (done, total) => {
                statusText.textContent = `正在验证候选备份 ${done} / ${total}`;
                if (total > 0) {
                    progress.classList.remove('cm-loading-progress-indeterminate');
                    progress.setAttribute('aria-valuemin', '0');
                    progress.setAttribute('aria-valuemax', String(total));
                    progress.setAttribute('aria-valuenow', String(done));
                    progressValue.style.width = `${Math.min(100, (done / total) * 100)}%`;
                }
            }, dialog.signal);
            stopLoading();
            status.remove();
            results.replaceChildren();
            if (!matches.length) {
                results.append(this.#state('没有找到能够关联到该聊天的备份', { empty: true }));
                return;
            }
            for (const backup of matches) {
                const row = this.#component('backup-row');
                this.#mount(row, '[data-cm-backup-name]').textContent = backup.file_name;
                this.#mount(row, '[data-cm-backup-meta]').textContent = `${backup.file_size} · ${backup.chat_items} 层 · ${backup.status === 'matched' ? '已匹配' : backup.status === 'confirm' ? '需要确认' : '读取失败'}`;
                this.#mount(row, '[data-cm-backup-reason]').textContent = backup.reason ?? '';
                this.#bindButton(this.#mount(row, '[data-cm-backup-view]', HTMLButtonElement), () => this.#viewBackup(backup));
                this.#bindButton(this.#mount(row, '[data-cm-backup-download]', HTMLButtonElement), () => this.backups.download(backup.file_name));
                results.append(row);
            }
        } catch (error) {
            if (dialog.signal.aborted) return;
            stopLoading();
            status.replaceWith(this.#state(error.message, { error: true }));
            notify('error', error.message);
        }
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

    async openSplit(record) {
        if (this.isGenerating()) return notify('warning', '聊天正在生成，当前不能分割');
        this.activeSplitClose?.();
        const dialog = this.#dialog(`分割聊天 · ${record.ownerName} / ${record.fileId}`, 'split');
        this.activeSplitRoot = dialog.root;
        this.activeSplitClose = dialog.close;
        const summary = this.#mount(dialog.body, '[data-cm-split-summary]');
        const mode = this.#mount(dialog.body, '[data-cm-split-mode]', HTMLSelectElement);
        const start = this.#mount(dialog.body, '[data-cm-split-start]', HTMLInputElement);
        const end = this.#mount(dialog.body, '[data-cm-split-end]', HTMLInputElement);
        const chunk = this.#mount(dialog.body, '[data-cm-split-chunk]', HTMLInputElement);
        const chunkRow = this.#mount(dialog.body, '[data-cm-split-chunk-field]');
        const preview = this.#mount(dialog.body, '[data-cm-split-preview]');
        const notice = this.#mount(dialog.body, '[data-cm-split-notice]');
        const acknowledge = this.#mount(dialog.body, '[data-cm-split-acknowledge]', HTMLInputElement);
        const generate = this.#mount(dialog.body, '[data-cm-split-generate]', HTMLButtonElement);
        const confirm = this.#mount(dialog.body, '[data-cm-split-confirm]', HTMLButtonElement);
        const stop = this.#mount(dialog.body, '[data-cm-split-stop]', HTMLButtonElement);
        const maxFloor = Math.max(0, record.messageCount - 1);
        summary.textContent = `${record.fileSize} · ${record.messageCount} 层`;
        this.#configureNumberInput(start, 0, 0, maxFloor);
        this.#configureNumberInput(end, maxFloor, 0, maxFloor);
        this.#configureNumberInput(chunk, 500, 1, Math.max(1, record.messageCount));
        mode.addEventListener('change', () => chunkRow.classList.toggle('cm-hidden', mode.value !== 'fixed'));
        this.#bindButton(generate, async () => {
            if (this.isGenerating()) return notify('warning', '聊天正在生成，不能生成预览');
            busy = true;
            syncControls();
            preview.replaceChildren(this.#state('正在读取原聊天并计算预览…'));
            try {
                plan = await this.splitter.prepare(record, {
                    mode: mode.value,
                    start: Number(start.value),
                    end: Number(end.value),
                    chunkSize: Number(chunk.value),
                }, dialog.signal);
                preview.replaceChildren();
                plan.parts.forEach(part => preview.append(this.#splitPart(describePart(part))));
                notice.classList.remove('cm-hidden');
                syncControls();
            } catch (error) {
                plan = null;
                if (dialog.signal.aborted) return;
                preview.replaceChildren(this.#state(error.message, { error: true }));
                notice.classList.add('cm-hidden');
                syncControls();
            } finally {
                busy = false;
                syncControls();
            }
        });
        this.#bindButton(confirm, async () => {
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
        this.#bindButton(stop, () => this.splitter.requestStop());
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
     * 从静态外壳和内容模板创建一个可叠加弹窗
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
        root.addEventListener('mousedown', event => {
            if (event.target === root && !closeButton.disabled) remove();
        });
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

    #formatDate(value) {
        const date = new Date(value);
        return Number.isNaN(date.valueOf()) ? String(value ?? '') : date.toLocaleString();
    }
}
