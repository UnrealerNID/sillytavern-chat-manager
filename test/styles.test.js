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
        './prompt-viewer/panel.css',
        './world-info-control/panel.css',
        './settings.css',
    ]);
    await Promise.all(imports.map(path => access(new URL(path, entryUrl))));
});

test('提示词查看器保持只读、可调整且不横向滚动', async () => {
    const css = await readFile(new URL('../styles/prompt-viewer/panel.css', import.meta.url), 'utf8');
    const ui = await readFile(new URL('../modules/prompt-viewer/ui.js', import.meta.url), 'utf8');
    const search = await readFile(new URL('../modules/prompt-viewer/search.js', import.meta.url), 'utf8');
    const template = await readFile(new URL('../templates/prompt-viewer/panel.html', import.meta.url), 'utf8');
    assert.match(css, /\.prompt-control-host\.prompt-control-floating\s*\{[^}]*position:\s*fixed/s);
    assert.match(css, /\.prompt-control-host\.prompt-control-floating\s*\{[^}]*z-index:\s*31100/s);
    assert.match(css, /\.prompt-control-host\.prompt-control-input\s*\{[^}]*bottom:\s*100%/s);
    assert.match(css, /data-prompt-resize="n"/);
    assert.match(css, /data-prompt-resize="se"/);
    assert.match(css, /\.prompt-control-content\s*\{[^}]*overflow-x:\s*hidden/s);
    assert.match(ui, /document\.body\.append\(this\.root\)/);
    assert.match(ui, /document\.querySelector\('#leftSendForm'\)/);
    assert.match(ui, /form\.append\(this\.root\)/);
    assert.match(ui, /tools\.append\(this\.trigger\)/);
    assert.match(ui, /POSITION_KEY/);
    assert.match(ui, /PANEL_SIZE_KEY/);
    assert.match(ui, /Role: \$\{roleIcon\(group\.role\)\} \$\{group\.role\}/);
    assert.match(template, /data-prompt-viewer-search/);
    assert.doesNotMatch(template, /switch|data-prompt-view=/);
    assert.match(ui, /new PromptSearchController/);
    assert.match(search, /scrollIntoView/);
    assert.doesNotMatch(ui, /setExcluded|clearCurrent|createSourceTree/);
});

test('世界书控制使用贴靠输入区的单一折叠入口', async () => {
    const [css, ui, scanner, template] = await Promise.all([
        readFile(new URL('../styles/world-info-control/panel.css', import.meta.url), 'utf8'),
        readFile(new URL('../modules/world-info-control/ui.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/world-info-control/scanner.js', import.meta.url), 'utf8'),
        readFile(new URL('../templates/world-info-control/panel.html', import.meta.url), 'utf8'),
    ]);
    assert.match(css, /\.world-info-control-host\s*\{[^}]*bottom:\s*100%/s);
    assert.match(css, /\.world-info-control-body\s*\{[^}]*height:\s*min\(420px, 55vh\)/s);
    assert.match(css, /\.world-info-control-content\s*\{[^}]*overflow:\s*auto/s);
    assert.match(css, /\.world-info-control-resize\s*\{[^}]*cursor:\s*ns-resize/s);
    assert.match(css, /\.world-info-control-entry-metadata\s*\{/);
    assert.match(css, /\.world-info-control-entry-metadata\s*\{[^}]*display:\s*grid/s);
    assert.match(css, /\.world-info-control-switch\s*\{[^}]*width:\s*28px[^}]*height:\s*16px/s);
    assert.match(css, /font-family:\s*var\(--mainFontFamily\)/);
    assert.match(css, /font-size:\s*calc\(var\(--mainFontSize\) \* 0\.9\)/);
    assert.match(css, /\.world-info-control-entry-content\s*\{[^}]*white-space:\s*pre-wrap/s);
    assert.doesNotMatch(ui, /element\('pre'/);
    assert.match(ui, /form\.append\(this\.root\)/);
    assert.doesNotMatch(ui, /#leftSendForm|tools\.append|this\.trigger/);
    assert.match(ui, /store\.setExcluded\(controlId/);
    assert.match(ui, /change === 'exclusions'/);
    assert.match(ui, /#syncExclusionState\(\)/);
    assert.match(ui, /scheduleRefresh\(\)/);
    assert.match(ui, /PANEL_HEIGHT_KEY/);
    assert.match(ui, /`锚点 \$\{entry\.outletName\}`/);
    assert.doesNotMatch(ui, /出口/);
    assert.match(scanner, /processedContent \?\? ''\)\.trim\(\)/);
    assert.match(scanner, /setStatus\('ready'\)[\s\S]*#scheduleTokenCounts/);
    assert.doesNotMatch(scanner, /await Promise\.all\(activatedEntries/);
    assert.match(template, /data-world-info-control-toggle/);
    assert.match(template, /data-world-info-control-body/);
    assert.match(template, /data-world-info-control-resize/);
    assert.doesNotMatch(template, /data-world-info-control-trigger/);
    assert.match(template, /data-world-info-control-search/);
    assert.match(template, /data-world-info-control-clear/);
    assert.match(ui, /className: 'toolbox-switch world-info-control-switch'/);
    assert.doesNotMatch(css, /\.world-info-control-switch span::after/);
});

test('普通消息正文保留换行但不使用代码块字体', async () => {
    const files = await Promise.all([
        readFile(new URL('../modules/prompt-viewer/ui.js', import.meta.url), 'utf8'),
        readFile(new URL('../styles/prompt-viewer/panel.css', import.meta.url), 'utf8'),
        readFile(new URL('../templates/chat-files/components.html', import.meta.url), 'utf8'),
        readFile(new URL('../templates/chat-files/data-maid-enhancer.html', import.meta.url), 'utf8'),
        readFile(new URL('../styles/chat-files/components.css', import.meta.url), 'utf8'),
    ]);
    const source = files.join('\n');
    assert.doesNotMatch(source, /<pre|element\('pre'|\.cm-message pre|\.prompt-control-message pre/);
    assert.match(source, /\.cm-message-content\s*\{[^}]*white-space:\s*pre-wrap/s);
    assert.match(source, /\.prompt-control-message-body\s*\{[^}]*white-space:\s*pre-wrap/s);
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
