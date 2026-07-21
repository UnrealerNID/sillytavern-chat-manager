/**
 * 补齐工具箱设置结构
 * @param {object} settings 酒馆保存的工具箱设置
 * @param {object[]} definitions 模块定义
 * @returns {object} 完整设置对象
 */
export function initializeToolboxSettings(settings, definitions) {
    settings.enabled ??= true;
    settings.modules ??= {};
    definitions.forEach(definition => definition.initializeSettings(settings));
    return settings;
}
