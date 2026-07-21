/**
 * 创建 DOM 元素，不插入不可信 HTML
 * @param {string} tag 标签名
 * @param {object} options 元素参数
 * @param {string} [options.className] 类名
 * @param {string} [options.text] 文本内容
 * @param {string} [options.title] 悬停说明
 * @param {string} [options.type] 按钮类型
 * @param {Record<string,string>} [options.attrs] HTML 属性
 * @returns {HTMLElement} 元素
 */
export function element(tag, options = {}) {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = options.text;
    if (options.title) node.title = options.title;
    if (options.type && node instanceof HTMLButtonElement) node.type = options.type;
    for (const [name, value] of Object.entries(options.attrs ?? {})) node.setAttribute(name, value);
    return node;
}
