/**
 * 保存提示词查看器的状态和最近一次提示词快照
 */
export class PromptViewerStore {
    constructor() {
        this.snapshot = null;
        this.status = 'idle';
        this.error = '';
        this.listeners = new Set();
    }

    setSnapshot(snapshot) {
        this.snapshot = snapshot;
        this.status = snapshot ? 'ready' : 'idle';
        this.error = '';
        this.#notify();
    }

    setLoading() {
        this.snapshot = null;
        this.status = 'loading';
        this.error = '';
        this.#notify();
    }

    setError(message) {
        this.snapshot = null;
        this.status = 'error';
        this.error = String(message || '提示词获取失败');
        this.#notify();
    }

    getSnapshot() {
        return this.snapshot;
    }

    getStatus() {
        return this.status;
    }

    getError() {
        return this.error;
    }

    clear() {
        this.setSnapshot(null);
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    #notify() {
        for (const listener of this.listeners) listener('snapshot');
    }
}
