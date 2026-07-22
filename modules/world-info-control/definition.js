import { WorldInfoControlModule } from './module.js';

/**
 * 世界书发送控制模块定义
 */
export const worldInfoControlModuleDefinition = {
    id: 'worldInfoControl',
    settingsTemplate: 'templates/world-info-control/settings',

    initializeSettings(toolboxSettings) {
        toolboxSettings.modules.worldInfoControl ??= { enabled: true };
        toolboxSettings.modules.worldInfoControl.enabled ??= true;
    },

    isEnabled(toolboxSettings) {
        return toolboxSettings.modules.worldInfoControl.enabled !== false;
    },

    create(toolboxSettings) {
        return new WorldInfoControlModule({ toolboxSettings });
    },

    bindSettings({ root, settings, bindSwitch }) {
        const moduleSettings = settings.modules.worldInfoControl;
        bindSwitch(root, '[data-world-info-control-enabled]', () => moduleSettings.enabled, value => {
            moduleSettings.enabled = value;
        });
    },

    syncSettings({ root, settings, toolboxEnabled }) {
        const toggle = root.querySelector('[data-world-info-control-enabled]');
        if (toggle instanceof HTMLInputElement) toggle.disabled = !toolboxEnabled;
    },
};
