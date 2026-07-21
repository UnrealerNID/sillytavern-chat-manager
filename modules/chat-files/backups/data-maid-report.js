/**
 * 一次性观察酒馆原生数据清理报告
 *
 * 只读取响应副本，不改变原生请求、响应或渲染流程
 * @param {number} timeout 等待原生扫描发起请求的最长时间
 * @returns {object} 包含结果 Promise 和取消回调的捕获任务
 */
export function captureNextDataMaidReport(timeout = 120_000) {
    const originalFetch = globalThis.fetch;
    let settled = false;
    let captured = false;
    let rejectCapture;
    let wrappedFetch;
    let timer;

    const restore = () => {
        if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
        clearTimeout(timer);
    };
    const promise = new Promise((resolve, reject) => {
        rejectCapture = reject;
        const finish = (value, error) => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve(value);
        };
        wrappedFetch = function (input, init) {
            const url = typeof input === 'string' ? input : input?.url;
            const response = originalFetch.call(globalThis, input, init);
            if (!captured && String(url ?? '').includes('/api/data-maid/report')) {
                captured = true;
                // 请求已与本次点击关联，立即恢复 fetch，避免捕获后续无关扫描
                restore();
                void response.then(result => result.clone().json()).then(
                    value => finish(value),
                    error => finish(null, error),
                );
            }
            return response;
        };
        // 捕获阶段先安装观察器，让原生冒泡处理器继续独占扫描与渲染
        globalThis.fetch = wrappedFetch;
    });
    // 弹窗和原生监听可能跨越异步边界，观察器随本次扫描会话存活
    timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        restore();
        rejectCapture(new Error('等待酒馆数据清理报告超时'));
    }, timeout);

    return {
        promise,
        cancel: () => {
            if (settled) return;
            settled = true;
            restore();
            rejectCapture(new DOMException('操作已取消', 'AbortError'));
        },
    };
}
