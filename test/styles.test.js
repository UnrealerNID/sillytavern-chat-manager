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
        './inventory.css',
        './responsive.css',
        './settings.css',
    ]);
    await Promise.all(imports.map(path => access(new URL(path, entryUrl))));
});

test('file inventory stays above the manager panel and below dialogs', async () => {
    const [base, inventory] = await Promise.all([
        readFile(new URL('../styles/base.css', import.meta.url), 'utf8'),
        readFile(new URL('../styles/inventory.css', import.meta.url), 'utf8'),
    ]);
    assert.match(base, /\.cm-overlay\s*\{[^}]*z-index:\s*31000/s);
    assert.match(inventory, /#chat_manager_inventory_overlay\s*\{[^}]*z-index:\s*31500/s);
    assert.match(base, /\.cm-dialog-overlay\s*\{[^}]*z-index:\s*32000/s);
});
