import test from 'node:test';
import assert from 'node:assert/strict';
import { backupStateMatchesFilter, classifyBackupIntegrity } from '../modules/data-maid-enhancer.js';

test('backup integrity distinguishes linked, orphan and uncertain files without using names', () => {
    const active = new Set(['current-chat-id']);
    assert.equal(classifyBackupIntegrity('current-chat-id', active), 'linked');
    assert.equal(classifyBackupIntegrity('deleted-chat-id', active), 'orphan');
    assert.equal(classifyBackupIntegrity('', active), 'uncertain');
});

test('backup status filters distinguish orphan and uncertain files', () => {
    assert.equal(backupStateMatchesFilter('orphan', 'orphan'), true);
    assert.equal(backupStateMatchesFilter('uncertain', 'orphan'), false);
    assert.equal(backupStateMatchesFilter('uncertain', 'uncertain'), true);
    assert.equal(backupStateMatchesFilter('linked', 'uncertain'), false);
    assert.equal(backupStateMatchesFilter('orphan', 'issues'), true);
    assert.equal(backupStateMatchesFilter('uncertain', 'issues'), true);
    assert.equal(backupStateMatchesFilter('linked', 'issues'), false);
    assert.equal(backupStateMatchesFilter('linked', 'all'), true);
});
