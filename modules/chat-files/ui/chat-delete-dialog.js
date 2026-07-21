import { chatKey, formatBytes } from '../../shared/utils.js';
import { aggregateRecords } from './chat-list-renderer.js';

/**
 * 管理聊天删除确认与串行删除事务
 */
export class ChatDeleteDialog {
    /**
     * @param {object} dependencies 依赖项
     * @param {import('./templates.js').UiTemplates} dependencies.ui 模板工具
     * @param {import('../api.js').ChatManagerApi} dependencies.api 酒馆接口
     * @param {(record:object)=>Promise<void>} dependencies.deleteRecord 删除聊天
     * @param {()=>Promise<void>} dependencies.refreshRecentChats 刷新最近聊天
     * @param {()=>Promise<void>} dependencies.refresh 刷新管理列表
     * @param {()=>void} dependencies.resetSelection 重置批量选择
     * @param {()=>boolean} dependencies.isLoading 是否读取清单
     * @param {()=>boolean} dependencies.isGenerating 是否正在生成
     * @param {()=>boolean} dependencies.isSplitting 是否正在分卷
     * @param {(type:string,message:string)=>void} dependencies.notify 消息提示
     */
    constructor(dependencies) {
        Object.assign(this, dependencies);
    }

    /**
     * 显示删除确认并执行删除
     * @param {object[]} records 待删除聊天
     */
    async open(records) {
        if (!records.length || !this.#canDelete()) return;
        const unique = uniqueRecords(records);
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
        const aggregate = aggregateRecords(unique);
        const rows = new Map();

        summary.textContent = [
            `${unique.length} 个聊天文件`,
            `合计 ${aggregate.messageCount} 层 / ${formatBytes(aggregate.bytes)}`,
        ].join(' · ');
        confirmText.textContent = unique.length === 1
            ? '确认删除'
            : `确认删除 ${unique.length} 条`;
        for (const record of unique) {
            const row = this.#targetRow(record);
            rows.set(chatKey(record), row);
            list.append(row);
        }
        this.ui.bindButton(cancel, () => dialog.close());
        this.ui.bindButton(confirm, () => this.#execute({
            unique,
            rows,
            dialog,
            summary,
            cancel,
            confirm,
        }));
    }

    /**
     * 检查当前是否允许删除
     * @returns {boolean} 是否允许删除
     */
    #canDelete() {
        if (this.isLoading()) {
            this.notify('warning', '聊天清单正在读取，完成后才能删除聊天');
            return false;
        }
        if (this.isGenerating()) {
            this.notify('warning', '聊天正在生成，结束后才能删除聊天');
            return false;
        }
        if (this.isSplitting()) {
            this.notify('warning', '分卷任务正在写入聊天，完成后才能删除聊天');
            return false;
        }
        return true;
    }

    /**
     * 创建删除目标行
     * @param {object} record 聊天记录
     * @returns {HTMLElement} 目标行
     */
    #targetRow(record) {
        const row = this.ui.component('delete-target');
        this.ui.mount(row, '[data-cm-delete-owner]').textContent = record.ownerName;
        this.ui.mount(row, '[data-cm-delete-file]').textContent = record.fileId;
        this.ui.mount(row, '[data-cm-delete-facts]').textContent = [
            `${record.messageCount} 层`,
            record.fileSize,
        ].join(' · ');
        return row;
    }

    /**
     * 串行删除并在每一步验证文件状态
     * @param {object} context 删除上下文
     */
    async #execute({ unique, rows, dialog, summary, cancel, confirm }) {
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
                if (await this.api.chatExists(record)) {
                    throw new Error('酒馆原生删除链路未删除该文件');
                }
                succeeded++;
                status.textContent = '已删除';
                status.dataset.state = 'ready';
            } catch (error) {
                failed++;
                status.textContent = '删除失败';
                status.dataset.state = 'error';
                row.title = error.message;
            }
            summary.textContent = progressText(unique.length, succeeded, failed);
        }

        dialog.setClosable(true);
        cancel.disabled = false;
        cancel.textContent = '关闭';
        confirm.classList.add('cm-hidden');
        summary.textContent = resultText(succeeded, failed);
        this.resetSelection();
        if (succeeded > 0) await this.#refreshRecentChats();
        await this.refresh();
        this.notify(
            failed ? 'warning' : 'success',
            failed
                ? `已删除 ${succeeded} 条，${failed} 条失败`
                : `已删除 ${succeeded} 条聊天`,
        );
    }

    /**
     * 刷新酒馆最近聊天并隔离原生刷新失败
     */
    async #refreshRecentChats() {
        try {
            await this.refreshRecentChats();
        } catch (error) {
            console.warn('[酒馆工具箱] 刷新最近聊天失败', error);
        }
    }
}

/**
 * 按聊天键去重
 * @param {object[]} records 聊天记录
 * @returns {object[]} 去重结果
 */
function uniqueRecords(records) {
    return Array.from(new Map(records.map(record => [chatKey(record), record])).values());
}

/**
 * 生成删除进度文本
 * @param {number} total 总数
 * @param {number} succeeded 成功数
 * @param {number} failed 失败数
 * @returns {string} 进度文本
 */
function progressText(total, succeeded, failed) {
    return [
        `正在处理 ${succeeded + failed} / ${total}`,
        `已删除 ${succeeded} 条`,
        failed ? `失败 ${failed} 条` : '',
    ].filter(Boolean).join(' · ');
}

/**
 * 生成删除结果文本
 * @param {number} succeeded 成功数
 * @param {number} failed 失败数
 * @returns {string} 结果文本
 */
function resultText(succeeded, failed) {
    return [
        '处理完成',
        `已删除 ${succeeded} 条`,
        failed ? `失败 ${failed} 条` : '',
    ].filter(Boolean).join(' · ');
}
