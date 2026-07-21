import { formatBytes, parseJsonlResponse } from '../../shared/utils.js';

const PAGE_SIZE = 50;

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
     * @param {HTMLTemplateElement} dependencies.messageTemplate 消息行模板
     * @param {(selector:string,type?:Function)=>HTMLElement} dependencies.required 模板节点读取器
     */
    constructor({ root, api, messageTemplate, required }) {
        this.api = api;
        this.messageTemplate = messageTemplate;
        this.root = required('[data-cm-maid-viewer]');
        this.title = required('[data-cm-maid-viewer-title]');
        this.summary = required('[data-cm-maid-viewer-summary]');
        this.messages = required('[data-cm-maid-messages]');
        this.previous = required('[data-cm-maid-message-previous]', HTMLButtonElement);
        this.next = required('[data-cm-maid-message-next]', HTMLButtonElement);
        this.pageLabel = required('[data-cm-maid-message-page]');
        this.controller = null;
        required('[data-cm-maid-viewer-close]', HTMLButtonElement)
            .addEventListener('click', () => this.close());
    }

    /**
     * 查看指定备份
     * @param {object} item 备份增强条目
     * @param {string} token 数据清理安全令牌
     */
    async open(item, token) {
        this.controller?.abort();
        this.controller = new AbortController();
        const signal = this.controller.signal;
        let page = 0;
        this.root.classList.remove('cm-hidden');
        this.title.textContent = '查看聊天备份';
        this.summary.textContent = [
            item.record.name,
            formatBytes(Number(item.record.size ?? 0)),
        ].join(' · ');

        const load = async () => {
            const loading = this.#showLoading();
            try {
                const start = page * PAGE_SIZE;
                const collected = [];
                const response = await this.api.readDataMaidFile(token, item.record.hash, signal);
                await parseJsonlResponse(response, {
                    stopAfter: start + PAGE_SIZE + 1,
                    onMessage: (message, index) => {
                        if (index >= start && index <= start + PAGE_SIZE) {
                            collected.push(message);
                        }
                    },
                });
                const messages = collected.slice(0, PAGE_SIZE);
                this.messages.replaceChildren(...messages.map((message, index) => (
                    this.#message(message, start + index)
                )));
                if (!messages.length) this.messages.append(loading);
                this.pageLabel.textContent = `第 ${page + 1} 页`;
                this.previous.disabled = page <= 0;
                this.next.disabled = collected.length <= PAGE_SIZE;
            } catch (error) {
                if (signal.aborted) return;
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
        this.root.classList.add('cm-hidden');
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
