/**
 * 管理当前聊天的世界书条目与发送排除状态
 */
export class WorldInfoControlStore {
    constructor() {
        this.entries = [];
        this.status = 'idle';
        this.chatKey = '';
        this.exclusions = new Map();
        this.listeners = new Set();
    }

    /**
     * 切换当前聊天
     * @param {string} chatKey 聊天标识
     */
    setChatKey(chatKey) {
        if (this.chatKey === chatKey) return;
        this.chatKey = chatKey;
        this.entries = [];
        this.#notify('entries');
    }

    setEntries(entries) {
        this.entries = entries;
        this.#notify('entries');
    }

    getEntries() {
        return this.entries;
    }

    setStatus(status) {
        if (this.status === status) return;
        this.status = status;
        this.#notify('status');
    }

    getStatus() {
        return this.status;
    }

    getExclusions() {
        return new Set(this.exclusions.get(this.chatKey) ?? []);
    }

    isExcluded(controlId) {
        return this.exclusions.get(this.chatKey)?.has(controlId) ?? false;
    }

    setExcluded(controlId, excluded) {
        if (!controlId || !this.chatKey) return;
        const values = this.exclusions.get(this.chatKey) ?? new Set();
        if (excluded) values.add(controlId);
        else values.delete(controlId);
        if (values.size) this.exclusions.set(this.chatKey, values);
        else this.exclusions.delete(this.chatKey);
        this.#notify('exclusions');
    }

    clearCurrent() {
        if (this.exclusions.delete(this.chatKey)) this.#notify('exclusions');
    }

    clearAll() {
        this.entries = [];
        this.status = 'idle';
        this.exclusions.clear();
        this.#notify('entries');
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    #notify(change) {
        for (const listener of this.listeners) listener(change);
    }
}

/**
 * 创建当前聊天的稳定标识
 * @param {object} context 酒馆上下文
 * @returns {string} 聊天标识
 */
export function getWorldInfoControlChatKey(context) {
    const owner = context.groupId
        ? `group:${context.groupId}`
        : `character:${context.characterId ?? 'none'}`;
    return `${owner}:${context.chatId ?? 'none'}`;
}
