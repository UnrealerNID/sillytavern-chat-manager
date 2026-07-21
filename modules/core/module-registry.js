/**
 * 管理工具箱模块的延迟初始化与启停状态
 */
export class ToolboxModuleRegistry {
    /**
     * @param {object} options 配置项
     * @param {object} options.settings 工具箱设置
     * @param {object[]} options.definitions 模块定义
     * @param {(instance:object,definition:object)=>void} [options.onInitialized] 模块初始化回调
     */
    constructor({ settings, definitions, onInitialized = () => {} }) {
        this.settings = settings;
        this.definitions = definitions;
        this.onInitialized = onInitialized;
        this.states = new Map(definitions.map(definition => [definition.id, {
            instance: null,
            initializeTask: null,
        }]));
    }

    /**
     * 根据最新设置同步全部模块
     * @returns {Promise<void>} 状态同步完成
     */
    async applySettings() {
        await Promise.all(this.definitions.map(definition => this.#applyModule(definition)));
    }

    /**
     * 同步单个模块并防止并发初始化
     * @param {object} definition 模块定义
     */
    async #applyModule(definition) {
        const state = this.states.get(definition.id);
        const shouldEnable = this.settings.enabled !== false && definition.isEnabled(this.settings);
        if (!shouldEnable) {
            state.instance?.setEnabled(false);
            return;
        }

        if (!state.instance) {
            state.initializeTask ??= this.#initializeModule(definition, state);
            try {
                await state.initializeTask;
            } catch (error) {
                // 初始化失败后清空任务，下一次设置同步仍可重试
                state.initializeTask = null;
                throw error;
            }
        }

        // 初始化期间设置可能已经变化，以最新状态为准
        const stillEnabled = this.settings.enabled !== false && definition.isEnabled(this.settings);
        state.instance.setEnabled(stillEnabled);
    }

    /**
     * 创建并初始化模块实例
     * @param {object} definition 模块定义
     * @param {object} state 模块运行状态
     */
    async #initializeModule(definition, state) {
        const instance = definition.create(this.settings);
        await instance.initialize();
        state.instance = instance;
        state.initializeTask = null;
        this.onInitialized(instance, definition);
    }
}
