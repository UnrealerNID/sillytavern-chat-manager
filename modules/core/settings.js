const DEFAULT_CHAT_FILES_SETTINGS = Object.freeze({
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
 * 补齐工具箱设置结构
 * @param {object} settings 酒馆保存的工具箱设置
 * @returns {object} 完整设置对象
 */
export function initializeToolboxSettings(settings) {
    settings.enabled ??= true;
    settings.modules ??= {};
    settings.modules.chatFiles ??= {};

    const chatFiles = settings.modules.chatFiles;
    chatFiles.enabled ??= DEFAULT_CHAT_FILES_SETTINGS.enabled;
    chatFiles.integrations ??= {};
    chatFiles.view ??= {};

    for (const [key, value] of Object.entries(DEFAULT_CHAT_FILES_SETTINGS.integrations)) {
        chatFiles.integrations[key] ??= value;
    }
    for (const [key, value] of Object.entries(DEFAULT_CHAT_FILES_SETTINGS.view)) {
        chatFiles.view[key] ??= value;
    }
    return settings;
}

/**
 * 判断聊天文件模块当前是否实际运行
 * @param {object} settings 工具箱设置
 * @returns {boolean} 是否运行
 */
export function isChatFilesEnabled(settings) {
    return settings.enabled !== false && settings.modules.chatFiles.enabled !== false;
}
