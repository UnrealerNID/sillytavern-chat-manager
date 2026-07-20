import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('panel template exposes all stable UI mounts', async () => {
    const html = await readFile(new URL('../templates/panel.html', import.meta.url), 'utf8');
    for (const marker of [
        'data-cm-search',
        'data-cm-refresh',
        'data-cm-scope-current',
        'data-cm-scope-current-label',
        'data-cm-scope-all',
        'data-cm-group-owners',
        'data-cm-group-splits',
        'data-cm-batch-start',
        'data-cm-batch-cancel',
        'data-cm-batch-confirm',
        'data-cm-batch-count',
        'data-cm-inventory-open',
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

test('file inventory delegates chat cleanup and scans only orphan backups', async () => {
    const [html, source] = await Promise.all([
        readFile(new URL('../templates/inventory.html', import.meta.url), 'utf8'),
        readFile(new URL('../modules/file-inventory.js', import.meta.url), 'utf8'),
    ]);
    for (const marker of [
        'chat_manager_inventory_overlay',
        'data-cm-inventory-mode="all"',
        'data-cm-inventory-mode="orphan"',
        'data-cm-inventory-open-cleanup',
        'data-cm-inventory-scan-backups',
        'data-cm-inventory-select-all',
        'data-cm-inventory-delete-selected',
        'data-cm-inventory-viewer',
        'data-cm-inventory-delete-dialog',
        'data-cm-inventory-tab="chats"',
        'data-cm-inventory-tab="backups"',
        'data-cm-inventory-tab="orphanBackups"',
        'data-cm-inventory-row-template',
        'data-cm-inventory-previous',
        'data-cm-inventory-next',
    ]) {
        assert.match(html, new RegExp(marker));
    }
    assert.match(html, /清理孤立聊天/);
    assert.match(html, /检查孤立备份/);
    assert.doesNotMatch(html, /data-cm-inventory-tab="orphans"/);
    assert.match(html, /type="checkbox"/);
    assert.doesNotMatch(html, /打开酒馆数据清理/);
    assert.match(source, /document\.querySelector\('#data_maid_button'\)/);
    assert.match(source, /await this\.backups\.dispose\(\);\s*button\.click\(\)/);
    assert.doesNotMatch(source, /dataMaidReport\.chats|dataMaidReport\.groupChats/);
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
        'data-cm-split-preview-status',
        'data-cm-split-preview-detail',
        'data-cm-split-group-config',
        'cm-split-primary-fields',
        'cm-split-floor-fields',
        'cm-split-notice',
        'data-cm-dialog-content="delete-chats"',
        'data-cm-delete-list',
        'data-cm-delete-confirm',
        'data-cm-dialog-content="recovery"',
        'data-cm-recovery-list',
    ]) {
        assert.match(html, new RegExp(marker));
    }
    assert.doesNotMatch(html, /data-cm-split-generate/);
    assert.doesNotMatch(html, /data-cm-split-acknowledge/);
    assert.match(html, /不会修改或删除原聊天/);
    assert.match(html, /旧备份可能因保留数量上限被轮换清理/);
});

test('component templates expose every repeated card and action mount', async () => {
    const html = await readFile(new URL('../templates/components.html', import.meta.url), 'utf8');
    for (const marker of [
        'data-cm-component="chat-row"',
        'data-cm-chat-open',
        'data-cm-chat-select',
        'data-cm-chat-delete',
        'cm-chat-owner-line',
        'data-cm-chat-source',
        'data-cm-component="owner-group"',
        'data-cm-owner-toggle',
        'data-cm-owner-select',
        'data-cm-owner-latest',
        'data-cm-component="split-group"',
        'data-cm-split-continue',
        'data-cm-split-select',
        'data-cm-split-group-latest',
        'data-cm-component="backup-row"',
        'data-cm-backup-view',
        'data-cm-backup-download',
        'data-cm-backup-restore',
        'data-cm-backup-created',
        'data-cm-backup-preview',
        'data-cm-component="message"',
        'data-cm-message-content',
        'data-cm-component="split-part"',
        'data-cm-split-part-text',
        'data-cm-component="delete-target"',
        'data-cm-delete-status',
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

test('panels and dialogs do not close from backdrop clicks', async () => {
    const source = await readFile(new URL('../modules/ui.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /event\.target\s*===\s*root/);
    assert.doesNotMatch(source, /event\.target\s*===\s*this\.root/);
});

test('backup listing is only requested explicitly while chat files are stable', async () => {
    const [entry, backups, ui] = await Promise.all([
        readFile(new URL('../index.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/backups.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/ui.js', import.meta.url), 'utf8'),
    ]);
    assert.doesNotMatch(entry, /scheduleBackupWarmup|backups\.warmup/);
    assert.doesNotMatch(backups, /async warmup\s*\(/);
    assert.match(ui, /backup\.disabled\s*=\s*this\.isGenerating\(\)\s*\|\|\s*this\.splitter\.running/);
    assert.match(ui, /async openBackups\(record\)\s*{\s*if \(this\.isGenerating\(\)\)/);
    assert.match(ui, /if \(this\.splitter\.running\) return notify\('warning', '分割任务正在写入聊天/);
});

test('chat deletion uses SillyTavern native character and group workflows', async () => {
    const [entry, ui] = await Promise.all([
        readFile(new URL('../index.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/ui.js', import.meta.url), 'utf8'),
    ]);
    assert.match(entry, /deleteCharacterChatByName\(String\(characterId\), record\.fileId\)/);
    assert.match(entry, /deleteGroupChatByName\(group\.id, record\.fileId\)/);
    assert.match(ui, /this\.loading \|\| this\.refreshTask[\s\S]*聊天清单正在读取，完成后才能删除聊天/);
});

test('chat inventory resynchronizes on every open and coalesces concurrent refreshes', async () => {
    const [entry, api, ui] = await Promise.all([
        readFile(new URL('../index.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/api.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/ui.js', import.meta.url), 'utf8'),
    ]);
    assert.match(api, /listChatFiles\(signal\)/);
    assert.match(api, /listOwnerChatFiles\(owner, signal\)/);
    assert.match(ui, /if \(!this\.records \|\| !this\.isGenerating\(\)\) await this\.refresh\(\)/);
    assert.match(ui, /if \(this\.refreshKey === target\.key\) return this\.refreshTask/);
    assert.match(ui, /target\.scope === 'current' && target\.owner[\s\S]*listOwnerChatFiles\(target\.owner\)/);
    assert.match(ui, /const characters = new Map/);
    assert.match(ui, /const groups = new Map/);
    assert.match(entry, /ui\.invalidateChatFiles\(\)/);
});
