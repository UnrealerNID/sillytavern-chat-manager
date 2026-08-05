/**
 * 管理当前扫描结果与按世界书持久化的发送排除状态
 */
export class WorldInfoControlStore {
    /**
     * @param {object} [options] 配置项
     * @param {Record<string,string[]>} [options.exclusions] 按世界书保存的条目排除状态
     * @param {(exclusions:Record<string,string[]>)=>void} [options.onExclusionsChange] 排除状态变化回调
     */
    constructor({ exclusions = {}, onExclusionsChange = () => {} } = {}) {
        this.entries = [];
        this.loadedWorlds = new Set();
        this.status = 'idle';
        this.chatKey = '';
        this.snapshotReady = false;
        this.exclusions = deserializeExclusions(exclusions);
        this.onExclusionsChange = onExclusionsChange;
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
        this.loadedWorlds.clear();
        this.snapshotReady = false;
        this.#notify('entries');
    }

    setEntries(entries, loadedWorlds = this.loadedWorlds) {
        this.entries = entries;
        this.loadedWorlds = new Set(loadedWorlds);
        this.snapshotReady = true;
        this.#notify('entries');
    }

    /**
     * 判断当前聊天是否已经取得过完整快照
     * @returns {boolean} 是否已有快照
     */
    hasSnapshot() {
        return this.snapshotReady;
    }

    /**
     * 合并触发条目与当前世界书中持久关闭的条目
     * @param {object[]} currentEntries 本轮真实发送条目
     * @param {object[]} excludedEntries 当前加载世界书中的关闭条目
     * @returns {object[]} 可写入面板的完整快照
     */
    mergeSnapshotEntries(currentEntries, excludedEntries) {
        const entries = new Map(currentEntries.map(entry => [entry.controlId, entry]));
        const previousEntries = new Map(this.entries.map(entry => [entry.controlId, entry]));
        for (const excluded of excludedEntries) {
            if (entries.has(excluded.controlId)) continue;
            entries.set(excluded.controlId, previousEntries.get(excluded.controlId) ?? excluded);
        }
        return Array.from(entries.values());
    }

    /**
     * 原位补充 Token 数，避免后台统计完成时重建条目列表
     * @param {Map<string,number>} counts 条目标识与 Token 数
     */
    setTokenCounts(counts) {
        let changed = false;
        for (const entry of this.entries) {
            if (!counts.has(entry.controlId)) continue;
            entry.tokenCount = counts.get(entry.controlId);
            changed = true;
        }
        if (changed) this.#notify('tokens');
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
        const controlIds = new Set();
        for (const [worldName, entryIds] of this.exclusions) {
            for (const entryId of entryIds) controlIds.add(`world:${worldName}:${entryId}`);
        }
        return controlIds;
    }

    getRelevantExclusions() {
        const controlIds = new Set();
        for (const worldName of this.loadedWorlds) {
            for (const entryId of this.exclusions.get(worldName) ?? []) {
                controlIds.add(`world:${worldName}:${entryId}`);
            }
        }
        return controlIds;
    }

    isExcluded(controlId) {
        const identity = parseWorldControlId(controlId);
        return identity
            ? (this.exclusions.get(identity.worldName)?.has(identity.entryId) ?? false)
            : false;
    }

    setExcluded(controlId, excluded) {
        const identity = parseWorldControlId(controlId);
        if (!identity) return;
        const entryIds = this.exclusions.get(identity.worldName) ?? new Set();
        if (entryIds.has(identity.entryId) === excluded) return;
        if (excluded) entryIds.add(identity.entryId);
        else entryIds.delete(identity.entryId);
        if (entryIds.size) this.exclusions.set(identity.worldName, entryIds);
        else this.exclusions.delete(identity.worldName);
        this.#persistExclusions();
        this.#notify('exclusions');
    }

    clearLoaded() {
        let changed = false;
        for (const worldName of this.loadedWorlds) {
            changed = this.exclusions.delete(worldName) || changed;
        }
        if (!changed) return;
        this.#persistExclusions();
        this.#notify('exclusions');
    }

    resetRuntime() {
        this.entries = [];
        this.loadedWorlds.clear();
        this.status = 'idle';
        this.snapshotReady = false;
        this.#notify('entries');
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    #notify(change) {
        for (const listener of this.listeners) listener(change);
    }

    #persistExclusions() {
        this.onExclusionsChange(Object.fromEntries(
            Array.from(this.exclusions, ([worldName, entryIds]) => [worldName, Array.from(entryIds)]),
        ));
    }
}

/**
 * 将按世界书保存的排除记录转换为运行时集合
 * @param {Record<string,string[]>} exclusions 已保存的排除记录
 * @returns {Map<string,Set<string>>} 世界书名称与条目 ID 集合
 */
function deserializeExclusions(exclusions) {
    const result = new Map();
    if (!exclusions || typeof exclusions !== 'object' || Array.isArray(exclusions)) return result;
    for (const [worldName, values] of Object.entries(exclusions)) {
        if (!Array.isArray(values)) continue;
        const entryIds = values.filter(value => typeof value === 'string' && value);
        if (entryIds.length) result.set(worldName, new Set(entryIds));
    }
    return result;
}

/**
 * 从控制标识中提取世界书和条目 ID
 * @param {string} controlId 控制标识
 * @returns {object|null} 包含世界书名称与条目 ID 的标识
 */
function parseWorldControlId(controlId) {
    if (!controlId?.startsWith('world:')) return null;
    const identity = controlId.slice('world:'.length);
    const separator = identity.lastIndexOf(':');
    if (separator < 1 || separator === identity.length - 1) return null;
    return {
        worldName: identity.slice(0, separator),
        entryId: identity.slice(separator + 1),
    };
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
