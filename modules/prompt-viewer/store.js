/**
 * 保存最近一次真实发送的最终提示词
 */
export class PromptViewerStore {
    constructor() {
        this.snapshot = null;
        this.status = 'idle';
        this.listeners = new Set();
    }

    setSnapshot(snapshot) {
        this.snapshot = snapshot;
        this.status = snapshot ? 'ready' : 'idle';
        this.#notify();
    }

    getSnapshot() {
        return this.snapshot;
    }

    getStatus() {
        return this.status;
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
