const DEFAULT_TIMEOUT = 30_000;

/**
 * 等待酒馆延迟创建指定 DOM 目标
 * @param {()=>Element|null} find 查找目标
 * @param {object} [options] 等待选项
 * @param {Node} [options.root] 观察根节点
 * @param {AbortSignal} [options.signal] 取消信号
 * @param {number} [options.timeout] 最长等待时间
 * @returns {Promise<Element>} 找到的目标
 */
export function waitForDom(find, options = {}) {
    const root = options.root ?? document.documentElement;
    const signal = options.signal;
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    return new Promise((resolve, reject) => {
        let observer = null;
        let timer = null;
        const finish = (value, error) => {
            observer?.disconnect();
            if (timer !== null) clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (error) reject(error);
            else resolve(value);
        };
        const inspect = () => {
            const target = find();
            if (target) finish(target);
        };
        const abort = () => finish(null, new DOMException('DOM 等待已取消', 'AbortError'));
        if (signal?.aborted) return abort();
        const immediate = find();
        if (immediate) return finish(immediate);
        observer = new MutationObserver(inspect);
        observer.observe(root, { childList: true, subtree: true });
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish(null, new Error('等待酒馆界面超时')), timeout);
    });
}

/**
 * 等待符合选择器的元素
 * @param {string} selector CSS 选择器
 * @param {object} [options] 等待选项
 * @param {ParentNode} [options.queryRoot] 查询根节点
 * @param {Node} [options.root] 观察根节点
 * @param {AbortSignal} [options.signal] 取消信号
 * @param {number} [options.timeout] 最长等待时间
 * @returns {Promise<Element>} 找到的元素
 */
export function waitForElement(selector, options = {}) {
    const queryRoot = options.queryRoot ?? document;
    return waitForDom(() => queryRoot.querySelector(selector), options);
}

/**
 * 将对话框挂载到浏览器顶层并统一接管 Esc
 * @param {HTMLDialogElement} dialog 对话框
 * @param {()=>void} onCancel Esc 关闭请求
 */
export function showModalDialog(dialog, onCancel) {
    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        onCancel();
    });
    document.body.append(dialog);
    dialog.showModal();
}

/**
 * 关闭并移除顶层对话框
 * @param {HTMLDialogElement|null} dialog 对话框
 */
export function removeModalDialog(dialog) {
    if (!dialog) return;
    if (dialog.open) dialog.close();
    dialog.remove();
}
