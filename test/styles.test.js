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
