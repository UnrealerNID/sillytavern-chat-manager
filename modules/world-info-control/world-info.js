/**
 * 维护世界书激活条目并在正式扫描前应用临时排除
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
        this.knownEntries = new Map();
    }

    /**
     * 过滤本轮扫描使用的世界书副本
     * @param {object} payload 世界书加载事件参数
     */
    filterLoadedEntries(payload) {
        const exclusions = this.store.getExclusions();
        for (const key of ['globalLore', 'characterLore', 'chatLore', 'personaLore']) {
            const entries = payload?.[key];
            if (!Array.isArray(entries)) continue;
            for (let index = entries.length - 1; index >= 0; index -= 1) {
                if (exclusions.has(worldControlId(entries[index]))) entries.splice(index, 1);
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
        this.activatedEntries = this.activatedEntries.map(entry => ({
            ...entry,
            // 事件中的正文已替换宏；此处继续复用酒馆同一正则链路得到实际发送文本
            processedContent: this.processEntry(entry),
        }));
        for (const entry of this.activatedEntries) this.knownEntries.set(worldControlId(entry), entry);
    }

    /**
     * 取得最近一次扫描的激活条目
     * @returns {object[]} 激活条目
     */
    getActivatedEntries() {
        const entries = new Map(this.activatedEntries.map(entry => [worldControlId(entry), entry]));
        for (const controlId of this.store.getExclusions()) {
            if (controlId.startsWith('world:') && this.knownEntries.has(controlId)) {
                entries.set(controlId, this.knownEntries.get(controlId));
            }
        }
        return Array.from(entries.values());
    }

    reset() {
        this.activatedEntries = [];
        this.knownEntries.clear();
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
