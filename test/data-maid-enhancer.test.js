import test from 'node:test';
import assert from 'node:assert/strict';
import {
    backupStateMatchesFilter,
    classifyBackupIntegrity,
} from '../modules/chat-files/backups/data-maid-enhancer.js';
import { inspectDataMaidBackups } from '../modules/chat-files/backups/data-maid-inspector.js';

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

test('backup inspection reports progressive states with bounded file reads', async () => {
    const items = [
        { record: { hash: 'linked' }, state: 'unchecked' },
        { record: { hash: 'orphan' }, state: 'unchecked' },
        { record: { hash: 'broken' }, state: 'unchecked' },
    ];
    const states = [];
    const progress = [];
    const api = {
        async listChatFiles() {
            return [{ chat_metadata: { integrity: 'active-id' } }];
        },
        async readDataMaidFile(token, hash) {
            assert.equal(token, 'token');
            if (hash === 'broken') throw new Error('文件损坏');
            const integrity = hash === 'linked' ? 'active-id' : 'deleted-id';
            return new Response(`${JSON.stringify({ chat_metadata: { integrity } })}\n`);
        },
    };

    const result = await inspectDataMaidBackups({
        api,
        token: 'token',
        items,
        signal: new AbortController().signal,
        onState: item => states.push(item.state),
        onProgress: (done, total) => progress.push([done, total]),
    });

    assert.deepEqual(result, { orphan: 1, uncertain: 1 });
    assert.deepEqual(new Set(states), new Set(['linked', 'orphan', 'uncertain']));
    assert.equal(progress.length, items.length);
    assert.deepEqual(progress.at(-1), [items.length, items.length]);
});
