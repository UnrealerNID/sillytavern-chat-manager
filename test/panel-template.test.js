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
        'data-cm-data-maid-open',
        'data-cm-state',
        'data-cm-list',
        'data-cm-version',
        'data-cm-update',
        'data-cm-previous',
        'data-cm-next',
    ]) {
        assert.match(html, new RegExp(`\\b${marker}\\b`));
    }
    assert.match(html, /class="cm-scope-controls" role="radiogroup"/);
    assert.match(html, /role="radio"[^>]*data-cm-scope-current/);
    assert.match(html, /role="radio"[^>]*data-cm-scope-all/);
    assert.match(html, /role="switch"[^>]*data-cm-group-owners/);
    assert.match(html, /role="switch"[^>]*data-cm-group-splits/);
    assert.match(html, /class="cm-toolbar-actions"/);
    assert.match(html, /title="按角色或群组分组显示"/);
    assert.match(html, /title="按分卷组分组显示"/);
    assert.match(html, /title="打开酒馆数据清理"/);
    assert.match(html, /title="重新加载聊天列表"/);
    assert.doesNotMatch(html, />范围<|>显示<|>数据清理<|>刷新</);
});

test('data maid enhancement mounts after either native or plugin-triggered scans', async () => {
    const [html, source] = await Promise.all([
        readFile(new URL('../templates/data-maid-enhancer.html', import.meta.url), 'utf8'),
        readFile(new URL('../modules/data-maid-enhancer.js', import.meta.url), 'utf8'),
    ]);
    for (const marker of [
        'chat_manager_data_maid_enhancer',
        'data-cm-maid-scan',
        'data-cm-maid-search',
        'data-cm-maid-sort',
        'data-cm-maid-filter',
        'data-cm-maid-select-all',
        'data-cm-maid-delete-selected',
        'data-cm-maid-viewer',
        'data-cm-maid-delete-dialog',
        'data-cm-maid-controls-template',
    ]) {
        assert.match(html, new RegExp(marker));
    }
    assert.match(html, /检查孤立备份/);
    assert.match(html, /type="checkbox"/);
    assert.match(source, /document\.querySelector\('#data_maid_button'\)/);
    assert.match(source, /document\.addEventListener\('click', this\.documentClick, true\)/);
    assert.match(source, /closest\('\.dataMaidStartButton'\)/);
    assert.match(source, /#captureNextReport\(\)/);
    assert.doesNotMatch(source, /start\.click\(\)/);
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
    assert.match(ui, /if \(this\.loading\) return notify\('warning', '聊天清单正在读取，完成后才能删除聊天'\)/);
    assert.doesNotMatch(ui, /this\.loading \|\| this\.refreshTask[\s\S]*聊天清单正在读取，完成后才能删除聊天/);
    assert.match(ui, /#setLoading\(loading\)[\s\S]*this\.refreshButton\.disabled = loading;[\s\S]*this\.#syncSelectionControls\(\);[\s\S]*this\.#render\(\)/);
    assert.match(ui, /async #loadChatFiles\(target\)\s*{\s*this\.#setLoading\(true\)/);
    assert.match(ui, /finally\s*{\s*this\.#setLoading\(false\)/);
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
