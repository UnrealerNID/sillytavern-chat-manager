/**
 * 维护世界书激活条目并在正式扫描前应用发送排除
 */
export class WorldInfoPromptAdapter {
    /**
     * @param {object} options 配置项
     * @param {import('./store.js').WorldInfoControlStore} options.store 控制状态
     * @param {(entry:object)=>string} [options.processEntry] 酒馆原生世界书正文处理器
     */
    constructor({ store, processEntry = entry => String(entry?.content ?? '') }) {
        this.store = store;
        this.processEntry = processEntry;
        this.activatedEntries = [];
        this.entrySources = new Map();
        this.worldOrders = new Map();
        this.loadedWorlds = new Set();
    }

    /**
     * 过滤本轮扫描使用的世界书副本
     * @param {object} payload 世界书加载事件参数
     * @param {object} [options] 过滤选项
     * @param {boolean} [options.applyExclusions] 是否移除持久关闭项
     */
    filterLoadedEntries(payload, { applyExclusions = true } = {}) {
        const exclusions = applyExclusions ? this.store.getExclusions() : null;
        this.activatedEntries = [];
        this.entrySources.clear();
        this.worldOrders.clear();
        this.loadedWorlds.clear();
        const sources = {
            characterLore: 'character',
            globalLore: 'global',
            chatLore: 'chat',
            personaLore: 'persona',
        };
        for (const [key, sourceType] of Object.entries(sources)) {
            const entries = payload?.[key];
            if (!Array.isArray(entries)) continue;
            const sourceWorlds = new Map();
            for (const entry of entries) {
                const controlId = worldControlId(entry);
                this.entrySources.set(controlId, sourceType);
                if (entry.world) {
                    const worldName = String(entry.world);
                    this.loadedWorlds.add(worldName);
                    if (!sourceWorlds.has(worldName)) sourceWorlds.set(worldName, sourceWorlds.size);
                    this.worldOrders.set(`${sourceType}:${worldName}`, sourceWorlds.get(worldName));
                }
            }
            if (!applyExclusions) continue;
            for (let index = entries.length - 1; index >= 0; index -= 1) {
                if (exclusions?.has(worldControlId(entries[index]))) entries.splice(index, 1);
            }
        }
    }

    /**
     * 保存扫描当前实际激活条目
     * @param {object} payload 世界书扫描事件参数
     */
    captureActivatedEntries(payload) {
        const entries = payload?.activated?.entries;
        if (entries instanceof Map || entries instanceof Set) {
            this.activatedEntries = Array.from(entries.values());
        } else {
            this.activatedEntries = Array.isArray(entries) ? entries.slice() : [];
        }
        this.activatedEntries = this.activatedEntries.map(entry => {
            const sourceType = this.entrySources.get(worldControlId(entry)) ?? 'unknown';
            return {
                ...entry,
                sourceType,
                sourceOrder: this.worldOrders.get(`${sourceType}:${entry.world}`) ?? Number.MAX_SAFE_INTEGER,
                // 事件中的正文已替换宏；此处继续复用酒馆同一正则链路得到实际发送文本
                processedContent: this.processEntry(entry),
            };
        });
    }

    /**
     * 取得最近一次扫描的激活条目
     * @returns {object[]} 激活条目
     */
    getActivatedEntries() {
        return this.activatedEntries.slice();
    }

    /**
     * 取得最近一次扫描实际加载的世界书
     * @returns {Set<string>} 世界书名称集合
     */
    getLoadedWorlds() {
        return new Set(this.loadedWorlds);
    }

    reset() {
        this.activatedEntries = [];
        this.entrySources.clear();
        this.worldOrders.clear();
        this.loadedWorlds.clear();
    }
}

/**
 * 生成世界书条目的运行时控制标识
 * @param {object} entry 世界书条目
 * @returns {string} 控制标识
 */
export function worldControlId(entry) {
    return `world:${entry?.world ?? 'unknown'}:${entry?.uid}`;
}
