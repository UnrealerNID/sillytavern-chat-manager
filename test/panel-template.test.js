import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('panel template exposes all stable UI mounts', async () => {
    const html = await readFile(new URL('../templates/panel.html', import.meta.url), 'utf8');
    for (const marker of [
        'data-cm-search',
        'data-cm-sort',
        'data-cm-page-size',
        'data-cm-refresh',
        'data-cm-scope-current',
        'data-cm-scope-current-label',
        'data-cm-scope-all',
        'data-cm-group-owners',
        'data-cm-group-splits',
        'data-cm-batch-start',
        'data-cm-selection-toolbar',
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
    assert.match(html, /data-cm-search[\s\S]*data-cm-scope-current[\s\S]*data-cm-sort[\s\S]*data-cm-page-size[\s\S]*class="cm-toolbar-actions"/);
    assert.match(html, /role="radio"[^>]*data-cm-scope-current/);
    assert.match(html, /role="radio"[^>]*data-cm-scope-all/);
    assert.match(html, /role="switch"[^>]*data-cm-group-owners/);
    assert.match(html, /role="switch"[^>]*data-cm-group-splits/);
    assert.match(html, /class="cm-toolbar-actions"/);
    assert.match(html, /title="按角色或群组分组显示"/);
    assert.match(html, /title="按分卷组分组显示"/);
    assert.match(html, /title="打开酒馆数据清理"/);
    assert.match(html, /title="重新加载聊天列表"/);
    assert.match(html, /<i class="fa-solid fa-comments"/);
    assert.match(html, /<i class="fa-solid fa-address-card"/);
    assert.match(html, /<i class="fa-solid fa-address-book"/);
    assert.match(html, /<i class="fa-solid fa-arrows-rotate"/);
    assert.match(html, /aria-pressed="false"[^>]*data-cm-batch-start/);
    assert.match(html, /fa-square-check/);
    assert.match(html, /data-cm-batch-cancel[\s\S]{0,120}fa-eraser/);
    assert.match(html, /value="10">10 \/ 页<[\s\S]*value="25">25 \/ 页<[\s\S]*value="1000">1000 \/ 页</);
    assert.doesNotMatch(html, /fa-arrow-down-wide-short|fa-table-list/);
    assert.doesNotMatch(html, />取消选择<|>删除已选</);
    assert.match(html, /data-cm-selection-toolbar[\s\S]*data-cm-batch-count[\s\S]*data-cm-batch-cancel[\s\S]*data-cm-batch-confirm/);
    assert.match(html, /cm-panel-utilities[\s\S]*data-cm-data-maid-open/);
    assert.doesNotMatch(html, /data-cm-batch-start[^>]*[\s\S]{0,120}>批量删除</);
    assert.doesNotMatch(html, /fa-globe|fa-user"|fa-users|fa-list-check|fa-rotate-right/);
    assert.doesNotMatch(html, />范围<|>显示<|>数据清理<|>刷新</);
});

test('data maid enhancement mounts after either native or plugin-triggered scans', async () => {
    const [html, source, reportCapture] = await Promise.all([
        readFile(new URL('../templates/data-maid-enhancer.html', import.meta.url), 'utf8'),
        readFile(new URL('../modules/backups/data-maid-enhancer.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/backups/data-maid-report.js', import.meta.url), 'utf8'),
    ]);
    for (const marker of [
        'chat_manager_data_maid_enhancer',
        'data-cm-maid-scan',
        'data-cm-maid-search',
        'data-cm-maid-sort',
        'data-cm-maid-filter',
        'data-cm-maid-batch-start',
        'data-cm-maid-selection-toolbar',
        'data-cm-maid-select-all',
        'data-cm-maid-clear-selection',
        'data-cm-maid-delete-selected',
        'data-cm-maid-viewer',
        'data-cm-maid-delete-dialog',
        'data-cm-maid-controls-template',
    ]) {
        assert.match(html, new RegExp(marker));
    }
    assert.match(html, /title="检查备份对应关系"[^>]*data-cm-maid-scan/);
    assert.match(html, /value="orphan">仅孤立</);
    assert.match(html, /value="uncertain">仅待确认</);
    assert.match(html, /data-cm-maid-delete-selected[\s\S]*?>[\s\S]*fa-trash-can[\s\S]*<\/button>/);
    assert.doesNotMatch(html, /删除已选（|全选当前结果<\/button>/);
    assert.match(html, /type="checkbox"/);
    assert.doesNotMatch(html, />上一页<|>下一页<|fa-trash"/);
    assert.match(source, /document\.querySelector\('#data_maid_button'\)/);
    assert.match(source, /document\.addEventListener\('click', this\.documentClick, true\)/);
    assert.match(source, /closest\('\.dataMaidStartButton'\)/);
    assert.match(source, /captureNextDataMaidReport\(\)/);
    assert.match(reportCapture, /includes\('\/api\/data-maid\/report'\)/);
    assert.doesNotMatch(source, /start\.click\(\)/);
});

test('dialog templates expose every static dialog and dynamic mount', async () => {
    const html = await readFile(new URL('../templates/dialogs.html', import.meta.url), 'utf8');
    for (const marker of [
        'data-cm-dialog-shell',
        'data-cm-dialog-content="backups"',
        'data-cm-backup-status',
        'data-cm-backup-progress',
        'data-cm-backup-search',
        'data-cm-backup-sort',
        'data-cm-backup-results',
        'data-cm-dialog-content="backup-viewer"',
        'data-cm-message-list',
        'data-cm-dialog-content="split"',
        'data-cm-split-preview',
        'data-cm-split-preview-status',
        'data-cm-split-preview-detail',
        'data-cm-split-group-config',
        'cm-split-primary-fields',
        'cm-split-help',
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
    assert.doesNotMatch(html, /data-cm-split-mode|>模式</);
    assert.match(html, /data-cm-split-chunk/);
    assert.match(html, /每卷楼层数留空时只创建一卷/);
    assert.match(html, /data-cm-split-confirm>[\s\S]*<span>创建<\/span>/);
    assert.match(html, /不会修改或删除原聊天/);
    assert.match(html, /旧备份可能因保留数量上限被轮换清理/);
    assert.doesNotMatch(html, />上一页<|>下一页<|fa-trash"/);
});

test('opening native cleanup preserves the chat manager and rows open only from explicit actions', async () => {
    const [source, listRenderer] = await Promise.all([
        readFile(new URL('../modules/ui/ui.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/ui/chat-list-renderer.js', import.meta.url), 'utf8'),
    ]);
    assert.match(source, /data-cm-data-maid-open[^\n]*openDataMaid\(\)/);
    assert.doesNotMatch(source, /data-cm-data-maid-open[^}]*this\.close\(\)/);
    assert.match(listRenderer, /row\.addEventListener\('click',[\s\S]*!this\.isSelectionMode\(\)[\s\S]*select\.dispatchEvent/);
    assert.doesNotMatch(listRenderer, /row\.addEventListener\('click',[\s\S]*this\.#openChat/);
});

test('component templates expose every repeated card and action mount', async () => {
    const html = await readFile(new URL('../templates/components.html', import.meta.url), 'utf8');
    for (const marker of [
        'data-cm-component="welcome-group-controls"',
        'data-cm-welcome-group-owners',
        'data-cm-welcome-group-splits',
        'data-cm-component="chat-row"',
        'data-cm-chat-open',
        'data-cm-chat-view',
        'data-cm-chat-rename',
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
    assert.doesNotMatch(html, /data-cm-group-toggle-text|>展开<|>收起</);
    assert.doesNotMatch(html, />进入聊天<|>查找备份<|>创建分卷<|>删除聊天</);
    assert.match(html, /cm-chat-owner-line[\s\S]*data-cm-chat-owner[\s\S]*cm-chat-name-separator[\s\S]*data-cm-chat-file/);
    assert.doesNotMatch(html, /data-cm-chat-pin/);
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
    const [source, templates] = await Promise.all([
        readFile(new URL('../modules/ui/ui.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/ui/templates.js', import.meta.url), 'utf8'),
    ]);
    assert.doesNotMatch(source, /event\.target\s*===\s*root/);
    assert.doesNotMatch(source, /event\.target\s*===\s*this\.root/);
    assert.doesNotMatch(templates, /event\.target\s*===\s*root/);
});

test('backup listing is only requested explicitly while chat files are stable', async () => {
    const [entry, backups, ui, backupDialogs] = await Promise.all([
        readFile(new URL('../index.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/backups/backups.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/ui/ui.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/ui/backup-dialogs.js', import.meta.url), 'utf8'),
    ]);
    assert.doesNotMatch(entry, /scheduleBackupWarmup|backups\.warmup/);
    assert.doesNotMatch(backups, /async warmup\s*\(/);
    const listRenderer = await readFile(new URL('../modules/ui/chat-list-renderer.js', import.meta.url), 'utf8');
    assert.match(listRenderer, /backup\.disabled\s*=\s*blocked/);
    assert.match(backupDialogs, /async open\(record\)\s*{\s*if \(this\.isGenerating\(\)\)/);
    assert.match(backupDialogs, /if \(this\.isSplitting\(\)\) return this\.notify\('warning', '分卷任务正在写入聊天/);
    assert.match(backupDialogs, /search\.addEventListener\('input', refreshSummary\)/);
    assert.match(backupDialogs, /sort\.addEventListener\('change', refreshSummary\)/);
    assert.doesNotMatch(backupDialogs, /row\.addEventListener\('click'/);
});

test('chat deletion uses SillyTavern native character and group workflows', async () => {
    const [entry, ui, actions, deletion] = await Promise.all([
        readFile(new URL('../index.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/ui/ui.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/chat/chat-actions.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/ui/chat-delete-dialog.js', import.meta.url), 'utf8'),
    ]);
    assert.match(actions, /deleteCharacterChatByName\(String\(characterId\), record\.fileId\)/);
    assert.match(actions, /deleteGroupChatByName\(group\.id, record\.fileId\)/);
    assert.match(actions, /renameGroupOrCharacterChat\(\{/);
    assert.match(actions, /renderTemplateAsync\('chatRename'\)/);
    assert.match(entry, /refreshRecentChats: \(\) => openWelcomeScreen\(\{ force: true \}\)/);
    assert.match(deletion, /if \(this\.isLoading\(\)\)[\s\S]*聊天清单正在读取，完成后才能删除聊天/);
    assert.doesNotMatch(ui, /this\.loading \|\| this\.refreshTask[\s\S]*聊天清单正在读取，完成后才能删除聊天/);
    assert.match(ui, /#setLoading\(loading\)[\s\S]*this\.refreshButton\.disabled = loading;[\s\S]*this\.#syncSelectionControls\(\);[\s\S]*this\.#render\(\)/);
    assert.match(ui, /async #loadChatFiles\(target\)\s*{\s*this\.#setLoading\(true\)/);
    assert.match(ui, /finally\s*{\s*this\.#setLoading\(false\)/);
    assert.match(deletion, /if \(succeeded > 0\) await this\.#refreshRecentChats\(\)/);
    assert.match(ui, /if \(this\.selectionMode\) this\.#setSelectionMode\(false\)/);
});

test('chat viewer follows SillyTavern message rendering count', async () => {
    const source = await readFile(new URL('../modules/ui/backup-dialogs.js', import.meta.url), 'utf8');
    assert.match(source, /Number\(power_user\.chat_truncation\) \|\| Number\.MAX_SAFE_INTEGER/);
    assert.match(source, /const pages = Number\.isFinite\(total\)[\s\S]*let page = pages \? pages - 1 : 0/);
    assert.match(source, /async viewChat\(record\)/);
});

test('chat list pagination shares SillyTavern character page size', async () => {
    const [entry, ui] = await Promise.all([
        readFile(new URL('../index.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/ui/ui.js', import.meta.url), 'utf8'),
    ]);
    assert.match(entry, /accountStorage\.getItem\('Characters_PerPage'\)/);
    assert.match(entry, /accountStorage\.setItem\('Characters_PerPage', String\(options\.pageSize\)\)/);
    assert.doesNotMatch(entry, /settings\.pageSize\s*=/);
    assert.match(ui, /normalizePageSize\(viewOptions\.pageSize\)/);
});

test('split groups display newest volumes first and the source chat last', async () => {
    const source = await readFile(new URL('../modules/ui/chat-list-renderer.js', import.meta.url), 'utf8');
    assert.match(source, /sort\(\(left, right\) => right\.split\.sequence - left\.split\.sequence\)/);
    assert.match(source, /displayParts\.forEach[\s\S]*if \(group\.sourceRecord\)[\s\S]*source: true/);
});

test('main UI delegates dialog workflows to focused modules', async () => {
    const source = await readFile(new URL('../modules/ui/ui.js', import.meta.url), 'utf8');
    assert.ok(source.split(/\r?\n/).length < 850, '主 UI 控制器不应重新承载完整弹窗工作流');
    assert.match(source, /new UiTemplates\(/);
    assert.match(source, /new BackupDialogs\(/);
    assert.match(source, /new SplitDialogs\(/);
    assert.match(source, /return this\.backupDialogs\.open\(record\)/);
    assert.match(source, /return this\.splitDialogs\.open\(record, initialOptions\)/);
});

test('chat inventory resynchronizes on every open and coalesces concurrent refreshes', async () => {
    const [entry, api, ui] = await Promise.all([
        readFile(new URL('../index.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/platform/api.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/ui/ui.js', import.meta.url), 'utf8'),
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

test('welcome recent chats share grouping settings and preserve native chat actions', async () => {
    const [entry, ui, welcome] = await Promise.all([
        readFile(new URL('../index.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/ui/ui.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/ui/welcome-recent.js', import.meta.url), 'utf8'),
    ]);
    assert.match(entry, /source !== 'manager'[\s\S]*ui\?\.setGrouping\(options\)/);
    assert.match(entry, /source !== 'welcome'[\s\S]*welcomeRecent\?\.setGrouping\(options\)/);
    assert.match(entry, /onViewOptionsChange: options => saveViewOptions\(options, 'manager'\)/);
    assert.match(entry, /onOptionsChange: options => saveViewOptions\(options, 'welcome'\)/);
    assert.match(ui, /setGrouping\(options\)[\s\S]*this\.groupOwners = Boolean\(options\.groupOwners\)/);
    assert.match(welcome, /groupOwnerRecords\(records, session\.groupSplits, records\)/);
    assert.match(welcome, /groupSplitRecords\(records, records\)/);
    assert.match(welcome, /session\.rows\.map\(row => this\.#record/);
    assert.match(welcome, /this\.#render\(session\);[\s\S]*this\.onOptionsChange/);
    assert.match(welcome, /this\.#syncButtons\(session\);[\s\S]*title\.after\(controls\)/);
    assert.doesNotMatch(welcome, /splitButton\.disabled/);
    assert.match(welcome, /splitButton\.setAttribute\('aria-busy'/);
    assert.doesNotMatch(welcome, /\.renameChat.*addEventListener|\.deleteChat.*addEventListener|\.pinChat.*addEventListener/);
    assert.match(welcome, /sort\(\(left, right\) => right\.split\.sequence - left\.split\.sequence\)[\s\S]*children\.append\(sourceRow\)/);
});
