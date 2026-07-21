import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

test('style entry imports every responsibility module', async () => {
    const entryUrl = new URL('../styles/index.css', import.meta.url);
    const css = await readFile(entryUrl, 'utf8');
    const imports = Array.from(css.matchAll(/@import\s+url\("([^"]+)"\);/g), match => match[1]);

    assert.deepEqual(imports, [
        './base.css',
        './components.css',
        './panel.css',
        './dialogs.css',
        './data-maid-enhancer.css',
        './responsive.css',
        './settings.css',
    ]);
    await Promise.all(imports.map(path => access(new URL(path, entryUrl))));
});

test('data maid enhancement dialogs use the shared dialog layer', async () => {
    const base = await readFile(new URL('../styles/base.css', import.meta.url), 'utf8');
    assert.match(base, /\.cm-overlay\s*\{[^}]*z-index:\s*31000/s);
    assert.match(base, /\.cm-dialog-overlay\s*\{[^}]*z-index:\s*32000/s);
});

test('all plugin panels use the same readable disabled button style', async () => {
    const css = await readFile(new URL('../styles/base.css', import.meta.url), 'utf8');
    assert.match(css, /\.cm-panel \.menu_button,[\s\S]*\.cm-dialog \.menu_button\s*{\s*font-weight:\s*600/);
    assert.match(css, /\.cm-panel :is\(\.menu_button, \.cm-icon-button\):disabled/);
    assert.match(css, /\.cm-dialog :is\(\.menu_button, \.cm-icon-button\):disabled/);
    assert.match(css, /\.cm-data-maid-enhanced :is\(\.menu_button, \.cm-icon-button\):disabled/);
    assert.match(css, /color:\s*var\(--SmartThemeBodyColor\)\s*!important/);
    assert.match(css, /opacity:\s*0\.7\s*!important/);
    assert.match(css, /filter:\s*grayscale\(1\)\s*!important/);
});

test('toolbar controls share one fixed height without stretching refresh', async () => {
    const [base, panel] = await Promise.all([
        readFile(new URL('../styles/base.css', import.meta.url), 'utf8'),
        readFile(new URL('../styles/panel.css', import.meta.url), 'utf8'),
    ]);
    assert.match(panel, /--cm-toolbar-control-height:\s*34px/);
    assert.match(base, /\.cm-icon-action\s*{[\s\S]*height:\s*34px\s*!important/);
    assert.doesNotMatch(panel, /\.cm-refresh-button\s*{[^}]*align-self:\s*stretch/s);
    assert.doesNotMatch(panel, /\.cm-select-wrap > i/);
    assert.doesNotMatch(panel, /\.cm-(?:sort|page-size)\s*{[^}]*padding-left/s);
});

test('toolbar toggles reuse the native active state without custom color mapping', async () => {
    const [ui, css] = await Promise.all([
        readFile(new URL('../modules/ui/ui.js', import.meta.url), 'utf8'),
        readFile(new URL('../styles/panel.css', import.meta.url), 'utf8'),
    ]);
    assert.match(ui, /button\.classList\.toggle\('active', active\)/);
    assert.doesNotMatch(ui, /button\.classList\.toggle\('cm-active'/);
    assert.doesNotMatch(css, /cm-active|cm-(?:owner|split|cleanup)-accent|cm-control-accent/);
    assert.doesNotMatch(css, /\.cm-view-controls \.menu_button::after/);
});

test('batch selection keeps its entry in the primary row and its actions in a second row', async () => {
    const [ui, css] = await Promise.all([
        readFile(new URL('../modules/ui/ui.js', import.meta.url), 'utf8'),
        readFile(new URL('../styles/panel.css', import.meta.url), 'utf8'),
    ]);
    assert.match(ui, /#setSelectionMode\(!this\.selectionMode\)/);
    assert.match(ui, /this\.selectionToolbar\.classList\.toggle\('cm-hidden', !this\.selectionMode\)/);
    assert.match(ui, /this\.batchStartButton\.classList\.toggle\('active', this\.selectionMode\)/);
    assert.match(css, /\.cm-selection-toolbar\s*{/);
});

test('chat and backup rows follow the compact recent-chat rhythm', async () => {
    const [panel, components] = await Promise.all([
        readFile(new URL('../styles/panel.css', import.meta.url), 'utf8'),
        readFile(new URL('../styles/components.css', import.meta.url), 'utf8'),
    ]);
    assert.match(panel, /\.cm-chat-list\s*{[^}]*gap:\s*2px/s);
    assert.match(panel, /\.cm-chat-list > \*\s*{[^}]*flex:\s*0 0 auto/s);
    assert.match(panel, /\.cm-chat-row\s*{[^}]*padding:\s*5px 10px[^}]*border-radius:\s*10px[^}]*background:\s*transparent/s);
    assert.match(panel, /\.cm-chat-row:hover,[\s\S]*background:\s*var\(--white30a\)/);
    assert.match(panel, /\.cm-chat-message-row\s*{[^}]*font-size:\s*calc\(var\(--mainFontSize\) \* 0\.85\)/s);
    assert.match(panel, /body\.big-avatars \.cm-chat-preview\s*{[^}]*line-clamp:\s*4/s);
    assert.match(components, /\.cm-backup-row\s*{[^}]*margin:\s*0 0 2px[^}]*padding:\s*5px 10px[^}]*border-radius:\s*10px[^}]*background:\s*transparent/s);
});
