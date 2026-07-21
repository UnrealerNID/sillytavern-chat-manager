import { extension_settings } from '/scripts/extensions.js';

import { ChatFilesModule } from './modules/chat-files/module.js';
import { initializeToolboxSettings } from './modules/core/settings.js';
import { ToolboxSettingsPanel } from './modules/core/settings-panel.js';
import {
    ExtensionUpdater,
    loadExtensionMetadata,
} from './modules/platform/extension-updater.js';

let initialized = false;

/**
 * 通过酒馆扩展清单钩子激活工具箱
 * @returns {Promise<void>}
 */
export async function init() {
    if (initialized) return;
    initialized = true;

    const settings = initializeToolboxSettings(extension_settings.tavernToolbox ??= {});
    const metadata = await loadExtensionMetadata();
    const updater = new ExtensionUpdater(metadata.version);
    const chatFiles = new ChatFilesModule({ toolboxSettings: settings });
    await chatFiles.initialize();
    const panelUpdateView = chatFiles.getUpdateView();
    updater.register(panelUpdateView.button, panelUpdateView.version);

    const settingsPanel = new ToolboxSettingsPanel({
        settings,
        updater,
        onChange: () => chatFiles.applySettings(),
    });
    await insertSettingsWithRetry(settingsPanel);
}

/**
 * 插入设置卡片并兼容酒馆设置栏的延迟渲染
 * @param {ToolboxSettingsPanel} settingsPanel 设置面板
 * @returns {Promise<void>}
 */
async function insertSettingsWithRetry(settingsPanel) {
    try {
        if (await settingsPanel.insert()) return;
        setTimeout(() => {
            settingsPanel.insert().catch(error => {
                console.error('[酒馆工具箱] 插入扩展设置失败', error);
            });
        }, 1000);
    } catch (error) {
        console.error('[酒馆工具箱] 插入扩展设置失败', error);
    }
}
