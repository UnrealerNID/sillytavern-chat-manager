import { power_user } from '/scripts/power-user.js';
import { removeModalDialog, showModalDialog } from '../../platform/dom.js';
import { parseJsonlResponse } from '../../shared/data.js';
import { formatBytes } from '../../shared/files.js';

/**
 * 格式化数据清理面板中的日期
 * @param {unknown} value 日期值
 * @returns {string} 本地日期文本
 */
export function formatDataMaidDate(value) {
    const time = new Date(value ?? 0).valueOf();
    if (!Number.isFinite(time) || !time) return '未知时间';
    return new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(new Date(time));
}

/**
 * 管理数据清理面板中的备份查看弹窗
 */
export class DataMaidViewer {
    /**
     * @param {object} dependencies 依赖项
     * @param {import('../api.js').ChatManagerApi} dependencies.api 酒馆接口
     * @param {HTMLTemplateElement} dependencies.template 查看器模板
     * @param {HTMLTemplateElement} dependencies.messageTemplate 消息行模板
     */
    constructor({ api, template, messageTemplate }) {
        this.api = api;
        this.template = template;
        this.messageTemplate = messageTemplate;
        this.controller = null;
        this.dialog = null;
    }

    /**
     * 查看指定备份
     * @param {object} item 备份增强条目
     * @param {string} token 数据清理安全令牌
     */
    async open(item, token) {
        this.close();
        this.controller = new AbortController();
        const signal = this.controller.signal;
        const root = this.template.content.firstElementChild.cloneNode(true);
        if (!(root instanceof HTMLDialogElement)) throw new Error('备份查看模板根节点无效');
        const required = (selector, type = HTMLElement) => {
            const node = root.querySelector(selector);
            if (!(node instanceof type)) throw new Error(`备份查看模板缺少 ${selector}`);
            return node;
        };
        this.summary = required('[data-cm-maid-viewer-summary]');
        this.messages = required('[data-cm-maid-messages]');
        this.previous = required('[data-cm-maid-message-previous]', HTMLButtonElement);
        this.next = required('[data-cm-maid-message-next]', HTMLButtonElement);
        this.pageLabel = required('[data-cm-maid-message-page]');
        required('[data-cm-maid-viewer-close]', HTMLButtonElement)
            .addEventListener('click', () => this.close());
        const pageSize = Number(power_user.chat_truncation) || Number.MAX_SAFE_INTEGER;
        let page = 0;
        let loadRevision = 0;
        this.summary.textContent = [
            item.record.name,
            formatBytes(Number(item.record.size ?? 0)),
        ].join(' · ');
        this.dialog = root;
        showModalDialog(root, () => this.close());

        const load = async () => {
            const revision = ++loadRevision;
            const loading = this.#showLoading();
            this.previous.disabled = true;
            this.next.disabled = true;
            try {
                const start = page * pageSize;
                const collected = [];
                const response = await this.api.readDataMaidFile(token, item.record.hash, signal);
                await parseJsonlResponse(response, {
                    stopAfter: start + pageSize + 1,
                    onMessage: (message, index) => {
                        if (index >= start && index <= start + pageSize) {
                            collected.push(message);
                        }
                    },
                });
                if (revision !== loadRevision || signal.aborted) return;
                const messages = collected.slice(0, pageSize);
                this.messages.replaceChildren(...messages.map((message, index) => (
                    this.#message(message, start + index)
                )));
                if (!messages.length) this.messages.append(loading);
                this.pageLabel.textContent = `第 ${page + 1} 页`;
                this.previous.disabled = page <= 0;
                this.next.disabled = collected.length <= pageSize;
            } catch (error) {
                if (revision !== loadRevision || signal.aborted) return;
                loading.textContent = error.message;
                loading.classList.add('cm-error');
                this.messages.replaceChildren(loading);
            }
        };
        this.previous.onclick = () => {
            page--;
            void load();
        };
        this.next.onclick = () => {
            page++;
            void load();
        };
        await load();
    }

    /**
     * 关闭查看弹窗并取消读取
     */
    close() {
        this.controller?.abort();
        this.controller = null;
        const dialog = this.dialog;
        this.dialog = null;
        removeModalDialog(dialog);
    }

    /**
     * 创建加载状态
     * @returns {HTMLElement} 加载节点
     */
    #showLoading() {
        const loading = document.createElement('div');
        loading.className = 'cm-state';
        loading.textContent = '正在读取该页…';
        this.messages.replaceChildren(loading);
        return loading;
    }

    /**
     * 创建消息行
     * @param {object} message 消息
     * @param {number} index 消息楼层
     * @returns {HTMLElement} 消息节点
     */
    #message(message, index) {
        const row = this.messageTemplate.content.firstElementChild.cloneNode(true);
        row.querySelector('[data-cm-message-name]').textContent = `#${index} ${message.name ?? ''}`;
        row.querySelector('[data-cm-message-date]').textContent = formatDataMaidDate(message.send_date);
        row.querySelector('[data-cm-message-content]').textContent = String(message.mes ?? '');
        return row;
    }
}
