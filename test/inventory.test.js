import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatInventory } from '../modules/chat-files/chat/inventory.js';

test('inventory coalesces range changes and returns only the latest range', async () => {
    let releaseCurrent;
    const currentResponse = new Promise(resolve => { releaseCurrent = resolve; });
    let target = {
        key: 'current:character:a.png',
        scope: 'current',
        owner: { ownerType: 'character', ownerId: 'a.png' },
    };
    const calls = [];
    const loading = [];
    const api = {
        async listOwnerChatFiles() {
            calls.push('current');
            return currentResponse;
        },
        async listChatFiles() {
            calls.push('all');
            return [{ avatar: 'b.png', file_id: 'latest', file_name: 'latest.jsonl' }];
        },
    };
    const inventory = new ChatInventory({
        api,
        getContext: () => ({
            characters: [
                { avatar: 'a.png', name: 'A' },
                { avatar: 'b.png', name: 'B' },
            ],
            groups: [],
        }),
        getTarget: () => target,
        getAvatarUrl: record => record.ownerId,
        onLoading: value => loading.push(value),
    });

    const first = inventory.refresh();
    target = { key: 'all', scope: 'all', owner: null };
    const second = inventory.refresh();
    releaseCurrent([{ avatar: 'a.png', file_id: 'old', file_name: 'old.jsonl' }]);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.deepEqual(calls, ['current', 'all']);
    assert.equal(firstResult[0].ownerName, 'B');
    assert.deepEqual(secondResult, firstResult);
    assert.deepEqual(loading, [true, false]);
});
