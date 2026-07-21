import { ChatFilesModule } from './module.js';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    integrations: Object.freeze({
        nativeChatPanel: true,
        welcomeRecent: true,
        dataMaid: true,
    }),
    view: Object.freeze({
        groupOwners: false,
        groupSplits: false,
        sortOrder: 'newest',
    }),
});

/**
 * 聊天文件管理模块定义
 */
export const chatFilesModuleDefinition = {
    id: 'chatFiles',
    settingsTemplate: 'templates/chat-files/settings',

    /**
     * 补齐聊天文件管理设置
     * @param {object} toolboxSettings 工具箱设置
     */
    initializeSettings(toolboxSettings) {
        toolboxSettings.modules.chatFiles ??= {};
        const settings = toolboxSettings.modules.chatFiles;
        settings.enabled ??= DEFAULT_SETTINGS.enabled;
        settings.integrations ??= {};
        settings.view ??= {};
        for (const [key, value] of Object.entries(DEFAULT_SETTINGS.integrations)) {
            settings.integrations[key] ??= value;
        }
        for (const [key, value] of Object.entries(DEFAULT_SETTINGS.view)) {
            settings.view[key] ??= value;
        }
    },

    /**
     * 判断模块开关是否启用
     * @param {object} toolboxSettings 工具箱设置
     * @returns {boolean} 是否启用
     */
    isEnabled(toolboxSettings) {
        return toolboxSettings.modules.chatFiles.enabled !== false;
    },

    /**
     * 创建模块实例
     * @param {object} toolboxSettings 工具箱设置
     * @returns {ChatFilesModule} 模块实例
     */
    create(toolboxSettings) {
        return new ChatFilesModule({ toolboxSettings });
    },

    /**
     * 绑定模块设置控件
     * @param {object} options 配置项
     * @param {HTMLElement} options.root 模块设置根节点
     * @param {object} options.settings 工具箱设置
     * @param {Function} options.bindSwitch 开关绑定器
     */
    bindSettings({ root, settings, bindSwitch }) {
        const chatFiles = settings.modules.chatFiles;
        bindSwitch(root, '[data-chat-files-enabled]', () => chatFiles.enabled, value => {
            chatFiles.enabled = value;
        });
        bindSwitch(root, '[data-native-chat-panel-enabled]', () => chatFiles.integrations.nativeChatPanel, value => {
            chatFiles.integrations.nativeChatPanel = value;
        });
        bindSwitch(root, '[data-welcome-recent-enabled]', () => chatFiles.integrations.welcomeRecent, value => {
            chatFiles.integrations.welcomeRecent = value;
        });
        bindSwitch(root, '[data-data-maid-enabled]', () => chatFiles.integrations.dataMaid, value => {
            chatFiles.integrations.dataMaid = value;
        });
    },

    /**
     * 同步模块设置控件的禁用层级
     * @param {object} options 配置项
     * @param {HTMLElement} options.root 模块设置根节点
     * @param {object} options.settings 工具箱设置
     * @param {boolean} options.toolboxEnabled 工具箱总开关状态
     */
    syncSettings({ root, settings, toolboxEnabled }) {
        const moduleEnabled = settings.modules.chatFiles.enabled !== false;
        const moduleToggle = root.querySelector('[data-chat-files-enabled]');
        const integrations = root.querySelector('[data-chat-files-integrations]');
        if (moduleToggle instanceof HTMLInputElement) moduleToggle.disabled = !toolboxEnabled;
        if (!(integrations instanceof HTMLElement)) return;
        integrations.classList.toggle('toolbox-settings-disabled', !toolboxEnabled || !moduleEnabled);
        for (const input of integrations.querySelectorAll('input[type="checkbox"]')) {
            input.disabled = !toolboxEnabled || !moduleEnabled;
        }
    },
};
