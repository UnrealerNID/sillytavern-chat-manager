import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { initializeToolboxSettings } from '../modules/core/settings.js';

test('toolbox settings initialize one module and three independent integrations', () => {
    const definition = {
        initializeSettings(settings) {
            settings.modules.chatFiles = {
                enabled: true,
                integrations: {
                    nativeChatPanel: true,
                    welcomeRecent: true,
                    dataMaid: true,
                },
            };
        },
    };
    const settings = initializeToolboxSettings({}, [definition]);

    assert.equal(settings.enabled, true);
    assert.deepEqual(settings.modules.chatFiles.integrations, {
        nativeChatPanel: true,
        welcomeRecent: true,
        dataMaid: true,
    });
});

test('settings UI distinguishes toolbox, module and integration levels', async () => {
    const [html, moduleHtml, panel, definition, moduleSource] = await Promise.all([
        readFile(new URL('../templates/settings.html', import.meta.url), 'utf8'),
        readFile(new URL('../templates/chat-files/settings.html', import.meta.url), 'utf8'),
        readFile(new URL('../modules/core/settings-panel.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/chat-files/definition.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/chat-files/module.js', import.meta.url), 'utf8'),
    ]);

    assert.match(html, /toolbox-settings-master/);
    assert.match(html, /data-toolbox-modules/);
    assert.match(moduleHtml, /<fieldset class="toolbox-module-card"[\s\S]*<legend class="toolbox-module-legend">/);
    assert.equal((`${html}${moduleHtml}`.match(/role="switch"/g) ?? []).length, 5);
    assert.match(panel, /definition\.bindSettings/);
    assert.match(panel, /definition\.syncSettings/);
    assert.match(definition, /moduleToggle\.disabled = !toolboxEnabled/);
    assert.match(definition, /input\.disabled = !toolboxEnabled \|\| !moduleEnabled/);
    assert.match(moduleSource, /enabled && integrations\.nativeChatPanel !== false/);
    assert.match(moduleSource, /enabled && integrations\.welcomeRecent !== false/);
    assert.match(moduleSource, /enabled && integrations\.dataMaid !== false/);
});

test('extension version reads the manifest from the repository root', async () => {
    const source = await readFile(new URL('../modules/platform/extension-updater.js', import.meta.url), 'utf8');

    assert.match(source, /new URL\('\.\.\/\.\.\/manifest\.json', import\.meta\.url\)/);
    assert.doesNotMatch(source, /new URL\('\.\.\/manifest\.json', import\.meta\.url\)/);
});

test('提示词查看器与世界书控制使用独立模块开关', async () => {
    const [viewerHtml, viewerDefinition, viewerModule, controlHtml, controlModule] = await Promise.all([
        readFile(new URL('../templates/prompt-viewer/settings.html', import.meta.url), 'utf8'),
        readFile(new URL('../modules/prompt-viewer/definition.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/prompt-viewer/module.js', import.meta.url), 'utf8'),
        readFile(new URL('../templates/world-info-control/settings.html', import.meta.url), 'utf8'),
        readFile(new URL('../modules/world-info-control/module.js', import.meta.url), 'utf8'),
    ]);

    assert.match(viewerHtml, /data-prompt-viewer-enabled/);
    assert.match(viewerHtml, /data-prompt-viewer-floating/);
    assert.match(viewerDefinition, /floatingBubble:\s*true/);
    assert.match(viewerModule, /setFloatingMode\(this\.settings\.floatingBubble !== false\)/);
    assert.match(controlHtml, /data-world-info-control-enabled/);
    assert.match(controlModule, /WORLDINFO_ENTRIES_LOADED/);
    assert.doesNotMatch(controlModule, /CHAT_COMPLETION_PROMPT_READY/);
});
