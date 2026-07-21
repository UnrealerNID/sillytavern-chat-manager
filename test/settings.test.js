import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    initializeToolboxSettings,
    isChatFilesEnabled,
} from '../modules/core/settings.js';

test('toolbox settings initialize one module and three independent integrations', () => {
    const settings = initializeToolboxSettings({});

    assert.equal(settings.enabled, true);
    assert.deepEqual(settings.modules.chatFiles.integrations, {
        nativeChatPanel: true,
        welcomeRecent: true,
        dataMaid: true,
    });
    assert.equal(isChatFilesEnabled(settings), true);
    settings.modules.chatFiles.enabled = false;
    assert.equal(isChatFilesEnabled(settings), false);
    settings.modules.chatFiles.enabled = true;
    settings.enabled = false;
    assert.equal(isChatFilesEnabled(settings), false);
});

test('settings UI distinguishes toolbox, module and integration levels', async () => {
    const [html, panel, moduleSource] = await Promise.all([
        readFile(new URL('../templates/settings.html', import.meta.url), 'utf8'),
        readFile(new URL('../modules/core/settings-panel.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/chat-files/module.js', import.meta.url), 'utf8'),
    ]);

    assert.match(html, /toolbox-settings-master/);
    assert.match(html, /<fieldset class="toolbox-module-card">[\s\S]*<legend class="toolbox-module-legend">/);
    assert.equal((html.match(/role="switch"/g) ?? []).length, 5);
    assert.match(panel, /moduleToggle\.disabled = !toolboxEnabled/);
    assert.match(panel, /input\.disabled = !toolboxEnabled \|\| !moduleEnabled/);
    assert.match(moduleSource, /moduleEnabled && integrations\.nativeChatPanel !== false/);
    assert.match(moduleSource, /moduleEnabled && integrations\.welcomeRecent !== false/);
    assert.match(moduleSource, /moduleEnabled && integrations\.dataMaid !== false/);
});

test('extension version reads the manifest from the repository root', async () => {
    const source = await readFile(new URL('../modules/platform/extension-updater.js', import.meta.url), 'utf8');

    assert.match(source, /new URL\('\.\.\/\.\.\/manifest\.json', import\.meta\.url\)/);
    assert.doesNotMatch(source, /new URL\('\.\.\/manifest\.json', import\.meta\.url\)/);
});
