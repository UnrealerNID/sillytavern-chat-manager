import { element } from '../shared/utils.js';

/**
 * 统一管理静态模板、挂载点和弹窗生命周期
 */
export class UiTemplates {
    /**
     * @param {string} dialogTemplates 弹窗模板注册表
     * @param {string} componentTemplates 组件模板注册表
     * @param {(type:string,message:string)=>void} notify 消息提示
     */
    constructor(dialogTemplates, componentTemplates, notify) {
        this.notify = notify;
        this.dialogSequence = 0;
        this.dialogTemplate = this.#registry(dialogTemplates, '[data-cm-dialog-shell]', '弹窗');
        this.dialogContents = this.#templateMap(dialogTemplates, 'data-cm-dialog-content');
        this.components = this.#templateMap(componentTemplates, 'data-cm-component');
    }

    /**
     * 从 HTML 字符串读取根节点
     * @param {string} html HTML 字符串
     * @param {string} label 错误名称
     * @returns {HTMLElement} 根节点
     */
    root(html, label) {
        const holder = document.createElement('template');
        holder.innerHTML = html.trim();
        const root = holder.content.firstElementChild;
        if (!(root instanceof HTMLElement)) throw new Error(`${label}模板无效`);
        return root;
    }

    /**
     * 读取并校验挂载点
     * @template {Element} T 元素类型
     * @param {ParentNode} root 查询根节点
     * @param {string} selector 选择器
     * @param {Function} [type=HTMLElement] 元素类型
     * @returns {T} 挂载点
     */
    mount(root, selector, type = HTMLElement) {
        const target = root.querySelector(selector);
        if (!(target instanceof type)) throw new Error(`聊天管理模板缺少挂载点 ${selector}`);
        return target;
    }

    /**
     * @param {string} name 组件名称
     * @returns {HTMLElement} 组件根节点
     */
    component(name) {
        const template = this.components.get(name);
        if (!(template instanceof HTMLTemplateElement)) throw new Error(`未找到组件模板 ${name}`);
        const root = template.content.firstElementChild?.cloneNode(true);
        if (!(root instanceof HTMLElement)) throw new Error(`组件模板 ${name} 无有效根节点`);
        return root;
    }

    /**
     * 创建只能显式关闭的叠加弹窗
     * @param {string|string[]} title 标题
     * @param {string} contentId 内容模板名称
     * @returns {object} 弹窗根节点、内容区、取消信号和生命周期操作
     */
    dialog(title, contentId) {
        const controller = new AbortController();
        const fragment = this.dialogTemplate.content.cloneNode(true);
        const root = this.mount(fragment, '[data-cm-dialog-overlay]');
        const panel = this.mount(fragment, '[data-cm-dialog-panel]');
        const heading = this.mount(fragment, '[data-cm-dialog-title]');
        const closeButton = this.mount(fragment, '[data-cm-dialog-close]', HTMLButtonElement);
        const body = this.mount(fragment, '[data-cm-dialog-body]');
        panel.classList.add(`cm-dialog-${contentId}`);
        heading.id = `cm_dialog_title_${++this.dialogSequence}`;
        panel.setAttribute('aria-labelledby', heading.id);
        if (Array.isArray(title)) {
            heading.classList.add('cm-dialog-title-lines');
            heading.title = title.join(' / ');
            heading.append(...title.map(text => element('span', { text })));
        } else {
            heading.textContent = title;
        }
        const contentTemplate = this.dialogContents.get(contentId);
        if (!(contentTemplate instanceof HTMLTemplateElement)) throw new Error(`未找到弹窗模板 ${contentId}`);
        body.append(contentTemplate.content.cloneNode(true));
        const close = () => {
            controller.abort();
            root.remove();
        };
        closeButton.addEventListener('click', close);
        document.body.append(root);
        return { root, body, signal: controller.signal, close, setClosable: value => { closeButton.disabled = !value; } };
    }

    /**
     * 统一绑定异步按钮错误处理
     * @param {HTMLButtonElement} button 按钮
     * @param {(event:MouseEvent)=>unknown|Promise<unknown>} handler 处理函数
     */
    bindButton(button, handler) {
        button.addEventListener('click', event => {
            event.stopPropagation();
            Promise.resolve(handler(event)).catch(error => {
                console.error(error);
                this.notify('error', error.message);
            });
        });
    }

    /**
     * @param {string} text 文案
     * @param {object} [options] 状态选项
     * @param {boolean} [options.error] 是否显示错误状态
     * @param {boolean} [options.empty] 是否显示空状态
     */
    state(text, { error = false, empty = false } = {}) {
        const state = this.component('state');
        state.classList.toggle('cm-error', error);
        state.classList.toggle('cm-empty', empty);
        this.mount(state, '[data-cm-state-text]').textContent = text;
        return state;
    }

    /**
     * @param {string} text 文案
     * @param {string} status 状态
     * @returns {HTMLElement} 分卷状态行
     */
    splitPart(text, status = '') {
        const row = this.component('split-part');
        if (status) row.classList.add(`cm-status-${status}`);
        this.mount(row, '[data-cm-split-part-text]').textContent = text;
        return row;
    }

    /**
     * @param {HTMLInputElement} input 输入框
     * @param {number} value 值
     * @param {number} min 最小值
     * @param {number} max 最大值
     */
    configureNumberInput(input, value, min, max) {
        input.value = String(value);
        input.min = String(min);
        input.max = String(max);
        input.step = '1';
    }

    /**
     * @param {unknown} value 日期值
     * @returns {string} 本地日期
     */
    formatDate(value) {
        const date = new Date(value);
        return Number.isNaN(date.valueOf()) ? String(value ?? '') : date.toLocaleString();
    }

    /**
     * @param {unknown} value 日期值
     * @returns {string} 本地短日期
     */
    formatShortDate(value) {
        const date = new Date(value);
        return Number.isNaN(date.valueOf()) ? String(value ?? '') : date.toLocaleDateString();
    }

    /**
     * @param {string} fileName 备份文件名
     * @returns {string} 创建时间
     */
    formatBackupDate(fileName) {
        const match = String(fileName).match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.jsonl$/i);
        if (!match) return '无法识别';
        const [, year, month, day, hour, minute, second] = match;
        return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).toLocaleString();
    }

    #registry(html, selector, label) {
        const root = this.root(html, `聊天管理${label}`);
        return this.mount(root, selector, HTMLTemplateElement);
    }

    #templateMap(html, attribute) {
        const root = this.root(html, '聊天管理组件');
        return new Map(Array.from(root.querySelectorAll(`[${attribute}]`), template => [template.getAttribute(attribute), template]));
    }
}
