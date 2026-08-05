import assert from 'node:assert/strict';
import test from 'node:test';

import { WorldInfoControlStore } from '../modules/world-info-control/store.js';

test('世界书快照在同一聊天内保持有效', () => {
    const store = new WorldInfoControlStore();

    store.setChatKey('character:1:chat-a');
    assert.equal(store.hasSnapshot(), false);

    store.setEntries([], new Set(['测试世界书']));
    assert.equal(store.hasSnapshot(), true);

    store.setStatus('scanning');
    store.setStatus('ready');
    assert.equal(store.hasSnapshot(), true);
});

test('切换聊天或关闭模块时清空当前快照', () => {
    const store = new WorldInfoControlStore();

    store.setChatKey('character:1:chat-a');
    store.setEntries([{ controlId: 'world:测试世界书:1' }]);
    store.setChatKey('character:1:chat-b');
    assert.equal(store.hasSnapshot(), false);
    assert.deepEqual(store.getEntries(), []);

    store.setEntries([]);
    store.resetRuntime();
    assert.equal(store.hasSnapshot(), false);
});

test('快照合并全部关闭条目并优先复用已有正文', () => {
    const store = new WorldInfoControlStore({
        exclusions: {
            当前世界书: ['2'],
            已移除世界书: ['3'],
        },
    });
    store.setEntries([
        { controlId: 'world:当前世界书:1', world: '当前世界书' },
        { controlId: 'world:当前世界书:2', world: '当前世界书' },
        { controlId: 'world:已移除世界书:3', world: '已移除世界书' },
    ]);

    const entries = store.mergeSnapshotEntries(
        [{ controlId: 'world:当前世界书:4', world: '当前世界书' }],
        [
            { controlId: 'world:当前世界书:2', world: '当前世界书', processedContent: '新读取正文' },
            { controlId: 'world:已移除世界书:3', world: '已移除世界书' },
        ],
    );

    assert.deepEqual(entries.map(entry => entry.controlId), [
        'world:当前世界书:4',
        'world:当前世界书:2',
        'world:已移除世界书:3',
    ]);
});
