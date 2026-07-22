/**
 * 管理提示词面板的搜索、标注和快速定位
 */
export class PromptSearchController {
    /**
     * @param {object} options 配置项
     * @param {HTMLInputElement} options.input 搜索输入框
     * @param {HTMLElement} options.count 结果计数
     * @param {HTMLButtonElement} options.previous 上一个按钮
     * @param {HTMLButtonElement} options.next 下一个按钮
     * @param {HTMLElement} options.content 搜索内容容器
     * @param {()=>void} options.onQueryChange 搜索内容变化回调
     */
    constructor({ input, count, previous, next, content, onQueryChange }) {
        this.input = input;
        this.count = count;
        this.previous = previous;
        this.next = next;
        this.content = content;
        this.onQueryChange = onQueryChange;
        this.query = '';
        this.results = [];
        this.index = -1;
    }

    bind() {
        this.input.addEventListener('input', () => {
            this.query = this.input.value.trim();
            this.index = -1;
            this.onQueryChange();
        });
        this.previous.addEventListener('click', () => this.#focus(-1));
        this.next.addEventListener('click', () => this.#focus(1));
    }

    sync() {
        this.results = this.query
            ? Array.from(this.content.querySelectorAll('[data-prompt-search-match="true"]'))
            : [];
        this.index = Math.min(this.index, this.results.length - 1);
        const disabled = this.results.length === 0;
        this.previous.disabled = disabled;
        this.next.disabled = disabled;
        this.results[this.index]?.classList.add('prompt-control-search-current');
        this.#renderCount();
    }

    /**
     * 判断任意文本是否命中当前搜索
     * @param {...unknown} values 候选文本
     * @returns {boolean} 是否命中
     */
    matches(...values) {
        if (!this.query) return false;
        const needle = this.query.toLocaleLowerCase();
        return values.some(value => String(value ?? '').toLocaleLowerCase().includes(needle));
    }

    /**
     * 写入文本并标注所有搜索片段
     * @param {HTMLElement} container 目标节点
     * @param {unknown} value 原始文本
     */
    appendHighlighted(container, value) {
        const text = String(value ?? '');
        if (!this.query) {
            container.append(document.createTextNode(text));
            return;
        }
        const source = text.toLocaleLowerCase();
        const needle = this.query.toLocaleLowerCase();
        let cursor = 0;
        let match = source.indexOf(needle);
        while (match >= 0) {
            container.append(document.createTextNode(text.slice(cursor, match)));
            const mark = document.createElement('mark');
            mark.textContent = text.slice(match, match + this.query.length);
            container.append(mark);
            cursor = match + this.query.length;
            match = source.indexOf(needle, cursor);
        }
        container.append(document.createTextNode(text.slice(cursor)));
    }

    /**
     * 将节点登记为可定位的搜索结果
     * @param {HTMLElement} element 结果节点
     */
    mark(element) {
        element.dataset.promptSearchMatch = 'true';
        element.classList.add('prompt-control-search-match');
    }

    #focus(direction) {
        if (!this.results.length) return;
        this.results[this.index]?.classList.remove('prompt-control-search-current');
        this.index = nextSearchIndex(this.index, this.results.length, direction);
        const target = this.results[this.index];
        if (target instanceof HTMLDetailsElement) target.open = true;
        for (let parent = target.parentElement; parent; parent = parent.parentElement) {
            if (parent instanceof HTMLDetailsElement) parent.open = true;
            if (parent === this.content) break;
        }
        target.classList.add('prompt-control-search-current');
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        this.#renderCount();
    }

    #renderCount() {
        if (!this.query) {
            this.count.textContent = '';
            return;
        }
        this.count.textContent = this.index >= 0
            ? `${this.index + 1} / ${this.results.length}`
            : `${this.results.length} 项`;
    }
}

/**
 * 计算循环定位后的结果索引
 * @param {number} current 当前索引
 * @param {number} length 结果数量
 * @param {-1|1} direction 定位方向
 * @returns {number} 下一索引
 */
export function nextSearchIndex(current, length, direction) {
    if (!length) return -1;
    if (current < 0) return direction > 0 ? 0 : length - 1;
    return (current + direction + length) % length;
}
