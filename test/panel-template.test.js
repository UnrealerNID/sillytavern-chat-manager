import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('panel template exposes all stable UI mounts', async () => {
    const html = await readFile(new URL('../panel.html', import.meta.url), 'utf8');
    for (const marker of [
        'data-cm-search',
        'data-cm-refresh',
        'data-cm-state',
        'data-cm-list',
        'data-cm-version',
        'data-cm-update',
        'data-cm-previous',
        'data-cm-next',
        'data-cm-dialog-template',
    ]) {
        assert.match(html, new RegExp(`\\b${marker}\\b`));
    }
});

test('panel and settings share the same version update controls', async () => {
    const [panel, settings] = await Promise.all([
        readFile(new URL('../panel.html', import.meta.url), 'utf8'),
        readFile(new URL('../settings.html', import.meta.url), 'utf8'),
    ]);
    for (const className of [
        'chat-manager-extension-meta',
        'chat-manager-extension-version',
        'chat-manager-update-action',
    ]) {
        assert.match(panel, new RegExp(`\\b${className}\\b`));
        assert.match(settings, new RegExp(`\\b${className}\\b`));
    }
});
