/**
 * 一次性观察酒馆原生数据清理报告
 *
 * 只读取响应副本，不改变原生请求、响应或渲染流程
 * @returns {object} 包含结果 Promise 和取消回调的捕获任务
 */
export function captureNextDataMaidReport() {
    const originalFetch = globalThis.fetch;
    let settled = false;
    let captured = false;
    let rejectCapture;
    let wrappedFetch;

    const restore = () => {
        if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
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
    // 原生点击处理会在当前事件轮次内发起报告请求
    queueMicrotask(() => {
        if (captured) return;
        restore();
        if (!settled) {
            settled = true;
            rejectCapture(new DOMException('操作已取消', 'AbortError'));
        }
    });

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
