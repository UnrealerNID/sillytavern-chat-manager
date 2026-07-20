import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBackupIntegrity } from '../modules/file-inventory.js';

test('backup integrity distinguishes linked, orphan and uncertain files without using names', () => {
    const active = new Set(['current-chat-id']);
    assert.equal(classifyBackupIntegrity('current-chat-id', active), 'linked');
    assert.equal(classifyBackupIntegrity('deleted-chat-id', active), 'orphan');
    assert.equal(classifyBackupIntegrity('', active), 'uncertain');
});
