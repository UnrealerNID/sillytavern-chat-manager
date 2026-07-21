import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('a failed extension check exposes the same coalesced check as a retry action', async () => {
    const source = await readFile(new URL('../modules/platform/extension-updater.js', import.meta.url), 'utf8');

    assert.match(source, /this\.checkTask \?\?= this\.#check\(\)\.finally/);
    assert.match(source, /state\.phase === 'check-failed'[^\n]+#requestCheck/);
    assert.match(source, /'check-failed': '重试检查'/);
    assert.doesNotMatch(source, /state\.phase = 'failed'/);
});
