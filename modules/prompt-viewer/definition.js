import { PromptViewerModule } from './module.js';

/**
 * 提示词查看器模块定义
 */
export const promptViewerModuleDefinition = {
    id: 'promptViewer',
    settingsTemplate: 'templates/prompt-viewer/settings',

    initializeSettings(toolboxSettings) {
        toolboxSettings.modules.promptViewer ??= {
            enabled: true,
            floatingBubble: true,
        };
        toolboxSettings.modules.promptViewer.enabled ??= true;
        toolboxSettings.modules.promptViewer.floatingBubble ??= true;
    },

    isEnabled(toolboxSettings) {
        return toolboxSettings.modules.promptViewer.enabled !== false;
    },

    create(toolboxSettings) {
        return new PromptViewerModule({ toolboxSettings });
    },

    bindSettings({ root, settings, bindSwitch }) {
        const moduleSettings = settings.modules.promptViewer;
        bindSwitch(root, '[data-prompt-viewer-enabled]', () => moduleSettings.enabled, value => {
            moduleSettings.enabled = value;
        });
        bindSwitch(root, '[data-prompt-viewer-floating]', () => moduleSettings.floatingBubble, value => {
            moduleSettings.floatingBubble = value;
        });
    },

    syncSettings({ root, settings, toolboxEnabled }) {
        const enabled = settings.modules.promptViewer.enabled !== false;
        const toggle = root.querySelector('[data-prompt-viewer-enabled]');
        const features = root.querySelector('[data-prompt-viewer-features]');
        if (toggle instanceof HTMLInputElement) toggle.disabled = !toolboxEnabled;
        if (!(features instanceof HTMLElement)) return;
        features.classList.toggle('toolbox-settings-disabled', !toolboxEnabled || !enabled);
        for (const input of features.querySelectorAll('input')) {
            input.disabled = !toolboxEnabled || !enabled;
        }
    },
};
