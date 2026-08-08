import {
    deriveIncrementalSplit,
    getSplitGroupState,
    orderSplitGroupRecords,
} from '../chat/grouping.js';
import { formatBytes, parseBytes } from '../../shared/files.js';
import {
    chatKey,
    uniqueChatRecords,
} from '../chat/identity.js';
import { bindGroupExpansion } from './group-expansion.js';

/**
 * 汇总聊天文件规模与最近记录
 * @param {object[]} records 聊天记录
 * @returns {object} 消息总数、文件总字节数和最近聊天
 */
export function aggregateRecords(records) {
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
 * 渲染聊天、角色组和分卷组
 */
export class ChatListRenderer {
    /**
     * @param {object} dependencies 依赖项
     * @param {import('./templates.js').UiTemplates} dependencies.ui 模板工具
     * @param {Map<string,object>} dependencies.selectedRecords 已选聊天
     * @param {()=>boolean} dependencies.isSelectionMode 是否处于批量选择
     * @param {()=>boolean} dependencies.isLoading 清单是否加载中
     * @param {()=>boolean} dependencies.isGenerating 酒馆是否正在生成
     * @param {()=>boolean} dependencies.isSplitting 是否正在分卷
     * @param {()=>void} dependencies.render 重新渲染列表
     * @param {()=>void} dependencies.syncSelection 同步选择控件
     * @param {()=>void} dependencies.closePanel 关闭主面板
     * @param {(record:object)=>Promise<void>} dependencies.openRecord 打开聊天
     * @param {(record:object)=>Promise<void>} dependencies.viewRecord 查看聊天
     * @param {(record:object)=>Promise<boolean>} dependencies.renameRecord 重命名聊天
     * @param {(record:object)=>void} dependencies.openBackups 打开备份
     * @param {(record:object,options?:object)=>void} dependencies.openSplit 打开分卷
     * @param {(records:object[])=>void} dependencies.confirmDelete 确认删除
     * @param {()=>Promise<void>} dependencies.refresh 刷新聊天清单
     * @param {(type:string,message:string)=>void} dependencies.notify 消息提示
     */
    constructor(dependencies) {
        Object.assign(this, dependencies);
        this.expandedOwners = new Set();
        this.expandedSplits = new Set();
        this.openingKey = null;
    }

    /**
     * 渲染一个列表单元
     * @param {object} unit 聊天或分组单元
     * @returns {HTMLElement} 列表节点
     */
    renderUnit(unit) {
        if (unit.type === 'owner-group') return this.#ownerGroup(unit);
        if (unit.type === 'split-group') return this.#splitGroup(unit);
        return this.#chatRow(unit.record);
    }

    /**
     * 渲染角色或群组
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
        const header = this.ui.mount(root, '[data-cm-owner-header]');
        const image = this.ui.mount(root, '[data-cm-owner-avatar]', HTMLImageElement);
        const indicator = this.ui.mount(root, '[data-cm-owner-toggle]');
        const children = this.ui.mount(root, '[data-cm-owner-children]');
        const expanded = this.expandedOwners.has(group.key);
        image.src = group.avatarUrl;
        image.alt = group.ownerName;
        this.ui.mount(root, '[data-cm-owner-name]').textContent = group.ownerName;

        const splitCount = group.splitGroupCount
            ?? group.children.filter(child => child.type === 'split-group').length;
        const ownerRecords = group.allRecords ?? group.records;
        const aggregate = aggregateRecords(ownerRecords);
        const summary = [
            `${ownerRecords.length} 条聊天`,
            splitCount ? `${splitCount} 个分卷组` : '',
            `文件合计 ${aggregate.messageCount} 层 / ${formatBytes(aggregate.bytes)}`,
        ].filter(Boolean).join(' · ');
        const latest = aggregate.latest
            ? `最近：${aggregate.latest.fileId} · ${this.ui.formatDate(aggregate.latest.lastMessageAt)}`
            : '没有可用的聊天记录';
        this.#setText(root, '[data-cm-owner-summary]', summary);
        this.#setText(root, '[data-cm-owner-latest]', latest);
        bindGroupExpansion(header, indicator, expanded, '聊天', () => {
            this.#toggleExpanded(this.expandedOwners, group.key, expanded);
        });
        if (expanded) {
            children.classList.remove('cm-hidden');
            group.children.forEach(child => children.append(this.renderUnit(child)));
        }
        return root;
    }

    /**
     * 渲染分卷组
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

        const header = this.ui.mount(root, '[data-cm-split-header]');
        const indicator = this.ui.mount(root, '[data-cm-split-toggle]');
        const children = this.ui.mount(root, '[data-cm-split-children]');
        const continueButton = this.ui.mount(root, '[data-cm-split-continue]', HTMLButtonElement);
        const incremental = deriveIncrementalSplit(group);
        const splitState = getSplitGroupState(group);
        const expanded = this.expandedSplits.has(group.key);
        const aggregate = aggregateRecords(splitRecords.map(item => item.record));
        this.ui.mount(root, '[data-cm-split-group-name]').textContent = group.rootChatId;

        const summary = [
            `${splitRecords.length} 个分卷`,
            `覆盖 #${splitState.start}–#${splitState.end}`,
            `逻辑合计 ${splitState.messageCount} 层 / ${formatBytes(aggregate.bytes)}`,
            group.sourceRecord ? '源聊天存在' : '仅保留分卷',
        ].join(' · ');
        const latest = aggregate.latest
            ? `最近：${aggregate.latest.fileId} · ${this.ui.formatDate(aggregate.latest.lastMessageAt)}`
            : '没有可用的分卷记录';
        this.#setText(root, '[data-cm-split-group-summary]', summary);
        this.#setText(root, '[data-cm-split-group-latest]', latest);
        this.#setText(root, '[data-cm-split-group-incremental]', `增量：${incremental.reason}`);

        continueButton.disabled = !incremental.available || this.isGenerating() || this.isSplitting();
        continueButton.title = incremental.available
            ? incremental.reason
            : `暂不可增量分卷：${incremental.reason}`;
        this.ui.bindButton(continueButton, () => this.openSplit(
            incremental.record,
            incremental.options,
        ));
        bindGroupExpansion(header, indicator, expanded, '分卷', () => {
            this.#toggleExpanded(this.expandedSplits, group.key, expanded);
        });
        if (expanded) {
            children.classList.remove('cm-hidden');
            for (const item of orderSplitGroupRecords(group)) {
                children.append(this.#chatRow(item.record, { source: item.source }));
            }
        }
        return root;
    }

    /**
     * 配置组选择框
     * @param {HTMLElement} wrap 选择框容器
     * @param {HTMLInputElement} input 选择框
     * @param {object[]} records 组内聊天
     */
    #configureGroupSelection(wrap, input, records) {
        const unique = uniqueChatRecords(records);
        const selectedCount = unique.filter(record => this.selectedRecords.has(chatKey(record))).length;
        wrap.classList.toggle('cm-hidden', !this.isSelectionMode());
        input.checked = unique.length > 0 && selectedCount === unique.length;
        input.indeterminate = selectedCount > 0 && selectedCount < unique.length;
        wrap.closest('.cm-record-group')?.classList.toggle('cm-selected', selectedCount > 0);
        input.addEventListener('change', () => {
            for (const record of unique) {
                const key = chatKey(record);
                if (input.checked) this.selectedRecords.set(key, record);
                else this.selectedRecords.delete(key);
            }
            this.syncSelection();
            this.render();
        });
    }

    /**
     * 渲染聊天行
     * @param {object} record 聊天记录
     * @param {object} options 显示选项
     * @param {boolean} [options.source] 是否标记为源聊天
     * @returns {HTMLElement} 聊天行
     */
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

        selectWrap.classList.toggle('cm-hidden', !this.isSelectionMode());
        select.checked = this.selectedRecords.has(key);
        row.classList.toggle('cm-source-record', source);
        sourceBadge.classList.toggle('cm-hidden', !source);
        image.src = record.avatarUrl;
        image.alt = record.ownerName;
        name.title = `${record.ownerName} - ${record.fileId}`;
        owner.textContent = record.ownerName;
        file.textContent = record.fileId;
        date.textContent = this.ui.formatDate(record.lastMessageAt);
        date.title = this.ui.formatDate(record.lastMessageAt);
        preview.textContent = record.preview;
        preview.title = record.preview;
        countWrap.title = `${record.messageCount} 层消息`;
        count.textContent = String(record.messageCount);
        size.textContent = record.fileSize;

        this.ui.bindButton(open, () => this.#openChat(record, key, row, open));
        this.ui.bindButton(view, () => this.viewRecord(record));
        this.ui.bindButton(rename, () => this.#renameChat(record));
        this.ui.bindButton(backup, () => this.openBackups(record));
        this.ui.bindButton(split, () => this.openSplit(record));
        this.ui.bindButton(remove, () => this.confirmDelete([record]));
        const blocked = this.isGenerating() || this.isSplitting();
        open.disabled = blocked;
        view.disabled = this.isLoading() || blocked;
        rename.disabled = this.isLoading() || blocked;
        backup.disabled = blocked;
        split.disabled = blocked || record.messageCount < 1;
        remove.disabled = this.isLoading() || blocked;

        select.addEventListener('change', () => {
            if (select.checked) this.selectedRecords.set(key, record);
            else this.selectedRecords.delete(key);
            row.classList.toggle('cm-selected', select.checked);
            this.syncSelection();
            this.render();
        });
        row.classList.toggle('cm-selected', select.checked);
        row.addEventListener('click', event => {
            if (event.target.closest('button, label') || !this.isSelectionMode()) return;
            select.checked = !select.checked;
            select.dispatchEvent(new Event('change'));
        });
        return row;
    }

    /**
     * 打开聊天并防止重复触发
     */
    async #openChat(record, key, row, button) {
        if (this.openingKey) return;
        this.openingKey = key;
        row.classList.add('cm-opening');
        button.disabled = true;
        try {
            await this.openRecord(record);
            this.closePanel();
        } finally {
            this.openingKey = null;
            row.classList.remove('cm-opening');
            button.disabled = this.isGenerating() || this.isSplitting();
        }
    }

    /**
     * 重命名聊天并刷新列表
     */
    async #renameChat(record) {
        try {
            if (!await this.renameRecord(record)) return;
            await this.refresh();
            this.notify('success', '聊天已重命名');
        } catch (error) {
            this.notify('error', error.message);
        }
    }

    /**
     * 更新带悬停全文的文本节点
     */
    #setText(root, selector, text) {
        const node = this.ui.mount(root, selector);
        node.textContent = text;
        node.title = text;
    }

    /**
     * 切换展开集合并刷新
     */
    #toggleExpanded(collection, key, expanded) {
        if (expanded) collection.delete(key);
        else collection.add(key);
        this.render();
    }
}
