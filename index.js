import { extension_settings } from '/scripts/extensions.js';

import { chatFilesModuleDefinition } from './modules/chat-files/definition.js';
import { ToolboxModuleRegistry } from './modules/core/module-registry.js';
import { initializeToolboxSettings } from './modules/core/settings.js';
import { ToolboxSettingsPanel } from './modules/core/settings-panel.js';
import { TOOLBOX_SETTINGS_KEY } from './modules/platform/extension-identity.js';
import { promptControlModuleDefinition } from './modules/prompt-control/definition.js';
import {
    ExtensionUpdater,
    loadExtensionMetadata,
} from './modules/platform/extension-updater.js';

const moduleDefinitions = [chatFilesModuleDefinition, promptControlModuleDefinition];
let initializationTask = null;
let runtime = null;

/**
 * 通过酒馆扩展清单钩子激活工具箱
 * @returns {Promise<void>}
 */
export async function init() {
    initializationTask ??= initializeToolbox().catch(error => {
        // 允许酒馆扩展钩子在临时初始化失败后重新调用
        initializationTask = null;
        throw error;
    });
    return initializationTask;
}

/**
 * 完成工具箱设置、模块和更新入口装配
 * @returns {Promise<void>}
 */
async function initializeToolbox() {
    runtime ??= await createRuntime();
    await runtime.settingsPanel.insert();
    await runtime.modules.applySettings();
}

/**
 * 创建可跨初始化重试复用的工具箱运行时
 * @returns {Promise<object>} 模块注册器与设置面板
 */
async function createRuntime() {
    const settings = initializeToolboxSettings(
        extension_settings[TOOLBOX_SETTINGS_KEY] ??= {},
        moduleDefinitions,
    );
    const metadata = await loadExtensionMetadata();
    const updater = new ExtensionUpdater(metadata.version);
    const modules = new ToolboxModuleRegistry({
        settings,
        definitions: moduleDefinitions,
        onInitialized: instance => {
            const view = instance.getUpdateView?.();
            if (view) updater.register(view.button, view.version);
        },
    });

    const settingsPanel = new ToolboxSettingsPanel({
        settings,
        definitions: moduleDefinitions,
        updater,
        onChange: () => modules.applySettings(),
    });
    return { modules, settingsPanel };
}
