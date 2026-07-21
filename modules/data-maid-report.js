/**
 * 一次性观察酒馆原生数据清理报告
 *
 * 只读取响应副本，不改变原生请求、响应或渲染流程
 * @param {number} timeout 超时时间
 * @returns {{promise:Promise<object>,cancel:()=>void}} 捕获任务
 */
export function captureNextDataMaidReport(timeout = 120_000) {
    const originalFetch = globalThis.fetch;
    let settled = false;
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
            restore();
            if (error) reject(error);
            else resolve(value);
        };
        wrappedFetch = async function (input, init) {
            const response = await originalFetch.call(globalThis, input, init);
            const url = typeof input === 'string' ? input : input?.url;
            if (String(url ?? '').includes('/api/data-maid/report')) {
                try {
                    finish(await response.clone().json());
                } catch (error) {
                    finish(null, error);
                }
            }
            return response;
        };
        // 捕获阶段先安装观察器，让原生冒泡处理器继续独占扫描与渲染
        globalThis.fetch = wrappedFetch;
    });
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
