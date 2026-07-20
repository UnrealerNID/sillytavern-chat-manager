import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveIncrementalSplit, filterChatRecords, getCurrentOwner, getStoredSplitConfigs, getStoredSplitIdentity, groupOwnerRecords, groupSplitRecords } from '../modules/grouping.js';

function record(fileId, overrides = {}) {
    return {
        ownerType: 'character',
        ownerId: '角色.png',
        ownerName: '角色',
        avatarUrl: '/avatar.png',
        fileId,
        messageCount: 100,
        ...overrides,
    };
}

function splitRecord(fileId, start, end, sequence, overrides = {}) {
    return record(fileId, {
        ...overrides,
        chatManager: {
            schema: 1,
            rootChatId: '长聊天',
            sourceStart: start,
            sourceEnd: end,
            sequence,
            splitMode: 'fixed',
            chunkSize: 100,
            ...overrides.chatManager,
        },
    });
}

test('defaults to character index zero and can switch back to all chats', () => {
    const owner = getCurrentOwner({
        characterId: 0,
        groupId: null,
        characters: [{ avatar: '角色.png' }, { avatar: '另一角色.png' }],
        groups: [],
    });
    const records = [record('当前聊天'), record('其他聊天', { ownerId: '另一角色.png', ownerName: '另一角色' })];
    assert.deepEqual(owner, { ownerType: 'character', ownerId: '角色.png', label: '当前角色' });
    assert.deepEqual(filterChatRecords(records, 'current', owner, '').map(item => item.fileId), ['当前聊天']);
    assert.equal(filterChatRecords(records, 'all', owner, '').length, 2);
});

test('reads split identity only from saved metadata', () => {
    const stored = splitRecord('任意文件名', 100, 199, 2);
    assert.deepEqual(getStoredSplitIdentity(stored), {
        rootChatId: '长聊天', sequence: 2, start: 100, end: 199, count: 100,
    });
    assert.equal(getStoredSplitIdentity(record('长聊天 [分卷 002] [#100-#199]')), null);
});

test('groups split records independently inside stable owner groups', () => {
    const records = [
        splitRecord('长聊天 [分卷 002-of-002] [#100-#199]', 100, 199, 2),
        record('长聊天'),
        record('普通聊天'),
        splitRecord('长聊天 [分卷 001-of-002] [#0-#99]', 0, 99, 1),
        record('另一角色聊天', { ownerId: '另一角色.png', ownerName: '另一角色' }),
    ];
    const splitUnits = groupSplitRecords(records);
    assert.equal(splitUnits[0].type, 'split-group');
    assert.deepEqual(splitUnits[0].records.map(item => item.split.sequence), [1, 2]);
    assert.equal(splitUnits[0].sourceRecord.fileId, '长聊天');
    assert.equal(splitUnits.some(unit => unit.type === 'record' && unit.record.fileId === '长聊天'), false);

    const owners = groupOwnerRecords(records, true);
    assert.equal(owners.length, 2);
    assert.equal(owners[0].children[0].type, 'split-group');
    assert.equal(owners[0].records.length, 4);
    assert.equal(owners[0].allRecords.length, 4);
});

test('group selections retain every owner and split record outside the filtered subset', () => {
    const all = [
        record('长聊天'),
        splitRecord('长聊天 - 1', 0, 99, 1),
        splitRecord('长聊天 - 2', 100, 199, 2),
        record('普通聊天'),
    ];
    const filtered = [all[1]];
    const [splitGroup] = groupSplitRecords(filtered, all);
    const [ownerGroup] = groupOwnerRecords(filtered, true, all);
    assert.deepEqual(splitGroup.allRecords.map(item => item.record.fileId), ['长聊天 - 1', '长聊天 - 2']);
    assert.equal(splitGroup.sourceRecord.fileId, '长聊天');
    assert.deepEqual(ownerGroup.allRecords.map(item => item.fileId), all.map(item => item.fileId));
});

test('derives incremental config from new messages in the last volume', () => {
    const [series] = groupSplitRecords([
        splitRecord('长聊天 [分卷 001-of-002] [#0-#99]', 0, 99, 1),
        splitRecord('长聊天 [分卷 002-of-002] [#100-#199]', 100, 199, 2, { messageCount: 145 }),
    ]);
    const incremental = deriveIncrementalSplit(series);

    assert.equal(incremental.available, true);
    assert.equal(incremental.sourceRecord.fileId, '长聊天 [分卷 002-of-002] [#100-#199]');
    assert.deepEqual(incremental.options, {
        mode: 'fixed',
        start: 100,
        end: 144,
        chunkSize: 100,
        sequenceStart: 3,
        incremental: true,
        outputRootChatId: '长聊天',
        rangeOffset: 100,
        groupConfigs: [{ mode: 'fixed', chunkSize: 100, occurrences: 2 }],
    });
});

test('reads selectable configs only from saved split metadata', () => {
    const [series] = groupSplitRecords([
        splitRecord('长聊天 [分卷 001] [#0-#99]', 0, 99, 1),
        splitRecord('长聊天 [分卷 002] [#100-#199]', 100, 199, 2),
        splitRecord('长聊天 [分卷 003] [#200-#249]', 200, 249, 3, { chatManager: { chunkSize: 50 } }),
        record('长聊天 [分卷 004] [#250-#274]'),
    ]);
    assert.deepEqual(getStoredSplitConfigs(series), [
        { mode: 'fixed', chunkSize: 100, occurrences: 2 },
        { mode: 'fixed', chunkSize: 50, occurrences: 1 },
    ]);
});

test('rejects incremental split when the last volume has no appended messages', () => {
    const [series] = groupSplitRecords([
        splitRecord('长聊天 [分卷 001-of-001] [#0-#99]', 0, 99, 1),
    ]);
    assert.deepEqual(deriveIncrementalSplit(series), {
        available: false,
        reason: '最后一卷没有新增楼层',
    });
});

test('does not infer incremental config when saved metadata is missing', () => {
    const [series] = groupSplitRecords([
        splitRecord('长聊天 [分卷 001] [#0-#99]', 0, 99, 1, {
            messageCount: 140,
            chatManager: { splitMode: null, chunkSize: null },
        }),
    ]);
    assert.deepEqual(deriveIncrementalSplit(series), {
        available: false,
        reason: '最后一卷没有分卷配置',
    });
});
