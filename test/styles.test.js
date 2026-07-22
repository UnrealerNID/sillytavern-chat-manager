import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

test('style entry imports every responsibility module', async () => {
    const entryUrl = new URL('../styles/index.css', import.meta.url);
    const css = await readFile(entryUrl, 'utf8');
    const imports = Array.from(css.matchAll(/@import\s+url\("([^"]+)"\);/g), match => match[1]);

    assert.deepEqual(imports, [
        './chat-files/base.css',
        './chat-files/components.css',
        './chat-files/panel.css',
        './chat-files/dialogs.css',
        './chat-files/data-maid-enhancer.css',
        './chat-files/responsive.css',
        './prompt-control/panel.css',
        './settings.css',
    ]);
    await Promise.all(imports.map(path => access(new URL(path, entryUrl))));
});

test('prompt panel stays compact, resizable and free of horizontal scrolling', async () => {
    const css = await readFile(new URL('../styles/prompt-control/panel.css', import.meta.url), 'utf8');
    const ui = await readFile(new URL('../modules/prompt-control/ui.js', import.meta.url), 'utf8');
    const viewModel = await readFile(new URL('../modules/prompt-control/view-model.js', import.meta.url), 'utf8');
    const search = await readFile(new URL('../modules/prompt-control/search.js', import.meta.url), 'utf8');
    const template = await readFile(new URL('../templates/prompt-control/panel.html', import.meta.url), 'utf8');
    assert.match(css, /\.prompt-control-host\.prompt-control-floating\s*\{[^}]*position:\s*fixed/s);
    assert.match(css, /\.prompt-control-host\.prompt-control-floating\s*\{[^}]*z-index:\s*31100/s);
    assert.match(css, /\.prompt-control-host\.prompt-control-input\s*\{[^}]*bottom:\s*100%/s);
    assert.match(css, /\.prompt-control-trigger\.prompt-control-input-trigger > i\s*\{[^}]*transform:\s*scale\(0\.86\)/s);
    assert.match(css, /data-prompt-resize="n"/);
    assert.match(css, /data-prompt-resize="se"/);
    assert.match(css, /\.prompt-control-content\s*\{[^}]*overflow-x:\s*hidden/s);
    assert.match(css, /\.prompt-control-tabs\s*\{[^}]*flex-wrap:\s*nowrap/s);
    assert.match(css, /\.prompt-control-tabs \.selected\s*\{[^}]*background:\s*var\(--white20a\)/s);
    assert.match(ui, /document\.body\.append\(root\)/);
    assert.match(ui, /document\.querySelector\('#leftSendForm'\)/);
    assert.match(ui, /form\.append\(this\.root\)/);
    assert.match(ui, /inputTools\.append\(this\.trigger\)/);
    assert.match(ui, /正在读取本轮提示词…/);
    assert.match(css, /prompt-control-loading-icon[^}]*animation:\s*prompt-control-spin/s);
    assert.match(css, /\.prompt-control-action-separator\s*\{[^}]*width:\s*1px/s);
    assert.match(
        css,
        /\.prompt-control-message pre,[\s\S]*\.prompt-control-single-content\s*\{[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s,
    );
    assert.match(css, /\.prompt-control-message\s*\{[^}]*overflow:\s*hidden[^}]*min-width:\s*0/s);
    assert.doesNotMatch(css, /prompt-control-contribution|prompt-control-text/);
    assert.doesNotMatch(css, /\.prompt-control-source-group\s*\{[^}]*overflow:\s*hidden/s);
    assert.match(ui, /POSITION_KEY/);
    assert.match(ui, /PANEL_SIZE_KEY/);
    assert.match(ui, /Role: \$\{roleIcon\(group\.role\)\} \$\{group\.role\}/);
    assert.match(ui, /\$\{formatNumber\(tokenCount\)\} Tokens/);
    assert.match(ui, /group\.nodes\.length === 1/);
    assert.doesNotMatch(ui, /group\.items\.length === 1/);
    assert.match(ui, /createSourceTree\(snapshot\.contributions\)/);
    assert.match(ui, /#createSourceGroup\(child, true\)/);
    assert.doesNotMatch(ui, /#createWorldGroup/);
    assert.doesNotMatch(ui, /details\.open = groupSize === 1/);
    assert.match(ui, /trim\(\)\.replace\(\/\\s\+\/g, ' '\)\.slice\(0, 320\)/);
    assert.doesNotMatch(template, /data-prompt-view="position"/);
    assert.match(template, />最终提示词<\/button>/);
    assert.match(template, />来源分类<\/button>/);
    assert.match(template, /prompt-control-header[\s\S]*data-prompt-control-collapse[\s\S]*<\/header>/);
    assert.match(template, /prompt-control-view-actions[\s\S]*data-prompt-control-clear/);
    assert.match(template, /prompt-control-action-separator[\s\S]*data-prompt-control-refresh/);
    assert.match(template, /data-prompt-control-search/);
    assert.doesNotMatch(template, /data-prompt-control-status/);
    assert.doesNotMatch(ui, /内容已变化，等待刷新/);
    assert.match(ui, /new PromptSearchController/);
    assert.match(search, /scrollIntoView/);
    assert.match(ui, /element\('details', \{ className: 'prompt-control-role-group' \}\)/);
    assert.match(ui, /nested \? 'prompt-control-source-branch' : 'prompt-control-source-group'/);
    assert.match(viewModel, /groupWorldInfoContributions/);
});

test('chat manager panels and modal dialogs use their dedicated layers', async () => {
    const base = await readFile(new URL('../styles/chat-files/base.css', import.meta.url), 'utf8');
    assert.match(base, /\.cm-overlay\s*\{[^}]*z-index:\s*31000/s);
    assert.match(base, /dialog\.cm-top-dialog\[open\][\s\S]*display:\s*flex/);
    assert.match(base, /dialog\.cm-top-dialog::backdrop/);
    assert.doesNotMatch(base, /\.cm-dialog-overlay/);
});

test('all plugin panels use the same readable disabled button style', async () => {
    const css = await readFile(new URL('../styles/chat-files/base.css', import.meta.url), 'utf8');
    assert.match(css, /\.cm-panel \.menu_button,[\s\S]*\.cm-dialog \.menu_button\s*{[^}]*font-weight:\s*600/s);
    assert.match(css, /\.cm-panel :is\(\.menu_button, \.cm-icon-button\):disabled/);
    assert.match(css, /\.cm-dialog :is\(\.menu_button, \.cm-icon-button\):disabled/);
    assert.match(css, /\.cm-data-maid-enhanced :is\(\.menu_button, \.cm-icon-button\):disabled/);
    assert.match(css, /color:\s*var\(--SmartThemeBodyColor\)\s*!important/);
    assert.match(css, /opacity:\s*0\.7\s*!important/);
    assert.match(css, /filter:\s*grayscale\(1\)\s*!important/);
});

test('toolbar controls share one fixed height without stretching refresh', async () => {
    const [base, panel] = await Promise.all([
        readFile(new URL('../styles/chat-files/base.css', import.meta.url), 'utf8'),
        readFile(new URL('../styles/chat-files/panel.css', import.meta.url), 'utf8'),
    ]);
    assert.match(panel, /--cm-toolbar-control-height:\s*34px/);
    assert.match(base, /\.cm-icon-action\s*{[\s\S]*height:\s*34px\s*!important/);
    assert.doesNotMatch(panel, /\.cm-refresh-button\s*{[^}]*align-self:\s*stretch/s);
    assert.doesNotMatch(panel, /\.cm-select-wrap > i/);
    assert.doesNotMatch(panel, /\.cm-(?:sort|page-size)\s*{[^}]*padding-left/s);
});

test('toolbar toggles reuse the native active state without custom color mapping', async () => {
    const [ui, css] = await Promise.all([
        readFile(new URL('../modules/chat-files/ui/ui.js', import.meta.url), 'utf8'),
        readFile(new URL('../styles/chat-files/panel.css', import.meta.url), 'utf8'),
    ]);
    assert.match(ui, /button\.classList\.toggle\('active', active\)/);
    assert.doesNotMatch(ui, /button\.classList\.toggle\('cm-active'/);
    assert.doesNotMatch(css, /cm-active|cm-(?:owner|split|cleanup)-accent|cm-control-accent/);
    assert.doesNotMatch(css, /\.cm-view-controls \.menu_button::after/);
});

test('batch selection keeps its entry in the primary row and its actions in a second row', async () => {
    const [ui, css] = await Promise.all([
        readFile(new URL('../modules/chat-files/ui/ui.js', import.meta.url), 'utf8'),
        readFile(new URL('../styles/chat-files/panel.css', import.meta.url), 'utf8'),
    ]);
    assert.match(ui, /#setSelectionMode\(!this\.selectionMode\)/);
    assert.match(ui, /this\.selectionToolbar\.classList\.toggle\('cm-hidden', !this\.selectionMode\)/);
    assert.match(ui, /this\.batchStartButton\.classList\.toggle\('active', this\.selectionMode\)/);
    assert.match(css, /\.cm-selection-toolbar\s*{/);
});

test('chat and backup rows follow the compact recent-chat rhythm', async () => {
    const [panel, components] = await Promise.all([
        readFile(new URL('../styles/chat-files/panel.css', import.meta.url), 'utf8'),
        readFile(new URL('../styles/chat-files/components.css', import.meta.url), 'utf8'),
    ]);
    assert.match(panel, /\.cm-chat-list\s*{[^}]*gap:\s*2px/s);
    assert.match(panel, /\.cm-chat-list > \*\s*{[^}]*flex:\s*0 0 auto/s);
    assert.match(panel, /\.cm-chat-row\s*{[^}]*padding:\s*5px 10px[^}]*border-radius:\s*10px[^}]*background:\s*transparent/s);
    assert.match(panel, /\.cm-chat-row:hover,[\s\S]*background:\s*var\(--white30a\)/);
    assert.match(panel, /\.cm-chat-message-row\s*{[^}]*font-size:\s*calc\(var\(--mainFontSize\) \* 0\.85\)/s);
    assert.match(panel, /body\.big-avatars \.cm-chat-preview\s*{[^}]*line-clamp:\s*4/s);
    assert.match(components, /\.cm-backup-row\s*{[^}]*margin:\s*0 0 2px[^}]*padding:\s*5px 10px[^}]*border-radius:\s*10px[^}]*background:\s*transparent/s);
    assert.match(components, /\.cm-welcome-group-controls\s*{[^}]*display:\s*flex/s);
    assert.match(components, /\.welcomePanel\.cm-welcome-enhanced \.recentChatsTitle/);
    assert.match(components, /\.welcomeRecent \.cm-group-children \.recentChat\s*{[^}]*margin-bottom:\s*2px/s);
});
