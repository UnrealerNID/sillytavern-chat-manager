import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('panel template exposes all stable UI mounts', async () => {
    const html = await readFile(new URL('../templates/panel.html', import.meta.url), 'utf8');
    for (const marker of [
        'data-cm-search',
        'data-cm-refresh',
        'data-cm-state',
        'data-cm-list',
        'data-cm-version',
        'data-cm-update',
        'data-cm-previous',
        'data-cm-next',
    ]) {
        assert.match(html, new RegExp(`\\b${marker}\\b`));
    }
});

test('dialog templates expose every static dialog and dynamic mount', async () => {
    const html = await readFile(new URL('../templates/dialogs.html', import.meta.url), 'utf8');
    for (const marker of [
        'data-cm-dialog-shell',
        'data-cm-dialog-content="backups"',
        'data-cm-backup-status',
        'data-cm-backup-progress',
        'data-cm-backup-results',
        'data-cm-dialog-content="backup-viewer"',
        'data-cm-message-list',
        'data-cm-dialog-content="split"',
        'data-cm-split-preview',
        'data-cm-dialog-content="recovery"',
        'data-cm-recovery-list',
    ]) {
        assert.match(html, new RegExp(marker));
    }
});

test('component templates expose every repeated card and action mount', async () => {
    const html = await readFile(new URL('../templates/components.html', import.meta.url), 'utf8');
    for (const marker of [
        'data-cm-component="chat-row"',
        'data-cm-chat-open',
        'data-cm-component="backup-row"',
        'data-cm-backup-view',
        'data-cm-backup-download',
        'data-cm-component="message"',
        'data-cm-message-content',
        'data-cm-component="split-part"',
        'data-cm-split-part-text',
        'data-cm-component="state"',
        'data-cm-state-text',
        'data-cm-component="recovery-task"',
        'data-cm-recovery-resume',
        'data-cm-recovery-clear',
    ]) {
        assert.match(html, new RegExp(marker));
    }
});

test('panel and settings share the same version update controls', async () => {
    const [panel, settings] = await Promise.all([
        readFile(new URL('../templates/panel.html', import.meta.url), 'utf8'),
        readFile(new URL('../templates/settings.html', import.meta.url), 'utf8'),
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
