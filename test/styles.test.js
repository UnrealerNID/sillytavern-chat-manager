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
        './responsive.css',
        './settings.css',
    ]);
    await Promise.all(imports.map(path => access(new URL(path, entryUrl))));
});
