import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { SplitService } from '../modules/chat-files/chat/splitter.js';
import { digestMessages } from '../modules/shared/data.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

function fixture() {
    const sourceId = '长聊天';
    const source = [
        { chat_metadata: { integrity: 'source-integrity' }, user_name: 'unused', character_name: 'unused' },
        ...Array.from({ length: 5 }, (_, index) => ({ name: index % 2 ? 'AI' : 'User', mes: `message-${index}`, is_user: index % 2 === 0 })),
    ];
    const files = new Map([[sourceId, source]]);
    const api = {
        getContext: () => ({ groups: [] }),
        getCharacterChats: async (_avatar, options) => Array.from(files, ([fileId, chat]) => options.simple
            ? { file_name: `${fileId}.jsonl`, file_id: fileId }
            : {
                file_name: `${fileId}.jsonl`,
                file_size: `${JSON.stringify(chat).length} B`,
                chat_items: chat.length - 1,
                last_mes: '2026-01-01T00:00:00.000Z',
                chat_metadata: chat[0].chat_metadata,
            }),
        getCharacterChat: async (_avatar, fileId) => files.get(fileId) ?? {},
        sanitizeFileName: async name => name,
        saveCharacterChat: async (_avatar, fileId, chat) => { files.set(fileId, chat); },
    };
    const journal = {
        tasks: new Map(),
        async put(task) { this.tasks.set(task.id, structuredClone(task)); },
        async remove(id) { this.tasks.delete(id); },
        async list() { return Array.from(this.tasks.values()); },
    };
    let id = 0;
    const splitter = new SplitService(api, journal, () => `uuid-${++id}`);
    const record = {
        ownerType: 'character',
        ownerId: '角色.png',
        ownerName: '角色',
        fileId: sourceId,
        fileName: `${sourceId}.jsonl`,
        fileSize: '1 KiB',
        messageCount: 5,
        lastMessageAt: '2026-01-01T00:00:00.000Z',
        preview: '',
    };
    return { splitter, files, record, api };
}

test('prepare and execute fixed-size character splits without changing source', async () => {
    const { splitter, files, record } = fixture();
    const original = structuredClone(files.get(record.fileId));
    const plan = await splitter.prepare(record, { mode: 'fixed', start: 0, end: 4, chunkSize: 2 });

    assert.equal(plan.parts.length, 3);
    assert.deepEqual(plan.parts.map(part => part.fileId), [`${record.fileId} - 1`, `${record.fileId} - 2`, `${record.fileId} - 3`]);
    assert.deepEqual(plan.parts.map(part => part.count), [2, 2, 1]);

    const task = await splitter.execute(plan);
    assert.equal(task.status, 'complete');
    assert.deepEqual(files.get(record.fileId), original);
    assert.equal(files.get(plan.parts[0].fileId).length, 3);
    assert.notEqual(files.get(plan.parts[0].fileId)[0].chat_metadata.integrity, 'source-integrity');
});

test('reuses a stable source snapshot for automatic preview updates', async () => {
    const { splitter, record, api } = fixture();
    let reads = 0;
    const readSource = api.getCharacterChat;
    api.getCharacterChat = async (...args) => {
        reads++;
        return readSource(...args);
    };

    const first = await splitter.prepare(record, { mode: 'range', start: 0, end: 4 });
    const second = await splitter.prepare(record, { mode: 'range', start: 1, end: 3 }, undefined, first.source);

    assert.equal(reads, 1);
    assert.deepEqual(second.parts.map(part => [part.start, part.end]), [[1, 3]]);
});

test('continues a split group with logical ranges and sequence numbers', async () => {
    const { splitter, record } = fixture();
    const plan = await splitter.prepare(record, {
        mode: 'fixed',
        start: 3,
        end: 4,
        chunkSize: 1,
        incremental: true,
        sequenceStart: 3,
        outputRootChatId: '逻辑分卷组',
        rangeOffset: 100,
    });

    assert.deepEqual(plan.parts.map(part => [part.sourceStart, part.sourceEnd, part.start, part.end]), [
        [3, 3, 103, 103],
        [4, 4, 104, 104],
    ]);
    assert.equal(plan.parts[0].fileId, '逻辑分卷组 - 3');
    assert.equal(plan.parts[1].fileId, '逻辑分卷组 - 4');
    assert.equal(plan.parts[0].header.chat_metadata.chat_manager.rootChatId, '逻辑分卷组');
});

test('registers a verified group split only after saving it', async () => {
    const sourceId = '群聊原记录';
    const header = { chat_metadata: { integrity: 'group-source' }, user_name: 'unused', character_name: 'unused' };
    const source = [header, { name: 'A', mes: '1' }, { name: 'B', mes: '2' }];
    const files = new Map([[sourceId, source]]);
    let group = { id: 'group-1', name: '群组', chats: [sourceId], chat_id: sourceId, members: [] };
    const api = {
        getContext: () => ({ groups: [group] }),
        getGroupInfo: async fileId => {
            const chat = files.get(fileId);
            if (!chat) throw new Error('missing');
            return { file_name: `${fileId}.jsonl`, file_size: `${JSON.stringify(chat).length} B`, chat_items: chat.length - 1, last_mes: '2026-01-01' };
        },
        getGroupChat: async fileId => files.get(fileId) ?? {},
        groupChatExists: async fileId => files.has(fileId),
        sanitizeFileName: async name => name,
        saveGroupChat: async (fileId, chat) => { files.set(fileId, chat); },
        getGroups: async () => [structuredClone(group)],
        editGroup: async updated => { group = structuredClone(updated); },
    };
    const journal = {
        async put() {},
        async remove() {},
        async list() { return []; },
    };
    let id = 0;
    const splitter = new SplitService(api, journal, () => `group-uuid-${++id}`);
    const record = {
        ownerType: 'group', ownerId: 'group-1', ownerName: '群组', fileId: sourceId,
        fileName: `${sourceId}.jsonl`, fileSize: '1 KiB', messageCount: 2, lastMessageAt: '2026-01-01', preview: '',
    };
    const plan = await splitter.prepare(record, { mode: 'range', start: 0, end: 1 });
    const task = await splitter.execute(plan);
    assert.equal(task.status, 'complete');
    assert.ok(group.chats.includes(plan.parts[0].fileId));
    assert.ok(files.has(plan.parts[0].fileId));
});

test('reconcile reads the group list once for every pending group task', async () => {
    const messages = [{ name: 'A', mes: 'same' }];
    const digest = await digestMessages(messages);
    let groupReads = 0;
    const task = {
        id: 'recovery',
        status: 'partial',
        record: { ownerType: 'group', ownerId: 'group-1' },
        parts: [
            { fileId: '卷一', count: 1, digest, status: 'writing' },
            { fileId: '卷二', count: 1, digest, status: 'verified' },
        ],
    };
    const api = {
        getGroupChat: async () => [{ chat_metadata: {} }, ...messages],
        getGroups: async () => {
            groupReads++;
            return [{ id: 'group-1', chats: ['卷一', '卷二'] }];
        },
    };
    const journal = {
        async list() { return [task]; },
        async put() {},
    };
    const splitter = new SplitService(api, journal, () => 'unused');

    const [reconciled] = await splitter.reconcile();
    assert.equal(groupReads, 1);
    assert.deepEqual(reconciled.parts.map(part => part.status), ['complete', 'complete']);
});
