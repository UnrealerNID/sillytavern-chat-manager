import { PromptControlModule } from './module.js';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    tavernHelper: true,
});

/**
 * 本轮提示词控制模块定义
 */
export const promptControlModuleDefinition = {
    id: 'promptControl',
    settingsTemplate: 'templates/prompt-control/settings',

    /**
     * 补齐本轮提示词控制设置
     * @param {object} toolboxSettings 工具箱设置
     */
    initializeSettings(toolboxSettings) {
        toolboxSettings.modules.promptControl ??= {};
        const settings = toolboxSettings.modules.promptControl;
        settings.enabled ??= DEFAULT_SETTINGS.enabled;
        settings.tavernHelper ??= DEFAULT_SETTINGS.tavernHelper;
    },

    /**
     * 判断模块是否启用
     * @param {object} toolboxSettings 工具箱设置
     * @returns {boolean} 是否启用
     */
    isEnabled(toolboxSettings) {
        return toolboxSettings.modules.promptControl.enabled !== false;
    },

    /**
     * 创建模块实例
     * @param {object} toolboxSettings 工具箱设置
     * @returns {PromptControlModule} 模块实例
     */
    create(toolboxSettings) {
        return new PromptControlModule({ toolboxSettings });
    },

    /**
     * 绑定模块设置控件
     * @param {object} options 配置项
     * @param {HTMLElement} options.root 模块设置根节点
     * @param {object} options.settings 工具箱设置
     * @param {Function} options.bindSwitch 开关绑定器
     */
    bindSettings({ root, settings, bindSwitch }) {
        const promptControl = settings.modules.promptControl;
        bindSwitch(root, '[data-prompt-control-enabled]', () => promptControl.enabled, value => {
            promptControl.enabled = value;
        });
        bindSwitch(root, '[data-prompt-helper-enabled]', () => promptControl.tavernHelper, value => {
            promptControl.tavernHelper = value;
        });
    },

    /**
     * 同步模块开关层级
     * @param {object} options 配置项
     * @param {HTMLElement} options.root 模块设置根节点
     * @param {object} options.settings 工具箱设置
     * @param {boolean} options.toolboxEnabled 工具箱总开关状态
     */
    syncSettings({ root, settings, toolboxEnabled }) {
        const enabled = settings.modules.promptControl.enabled !== false;
        const moduleToggle = root.querySelector('[data-prompt-control-enabled]');
        const features = root.querySelector('[data-prompt-control-features]');
        if (moduleToggle instanceof HTMLInputElement) moduleToggle.disabled = !toolboxEnabled;
        if (!(features instanceof HTMLElement)) return;
        features.classList.toggle('toolbox-settings-disabled', !toolboxEnabled || !enabled);
        for (const input of features.querySelectorAll('input[type="checkbox"]')) {
            input.disabled = !toolboxEnabled || !enabled;
        }
    },
};
