import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { SplitService } from '../modules/splitter.js';

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
    return { splitter, files, record };
}

test('prepare and execute fixed-size character splits without changing source', async () => {
    const { splitter, files, record } = fixture();
    const original = structuredClone(files.get(record.fileId));
    const plan = await splitter.prepare(record, { mode: 'fixed', start: 0, end: 4, chunkSize: 2 });

    assert.equal(plan.parts.length, 3);
    assert.match(plan.parts[0].fileId, /分卷 001-of-003/);
    assert.deepEqual(plan.parts.map(part => part.count), [2, 2, 1]);

    const task = await splitter.execute(plan);
    assert.equal(task.status, 'complete');
    assert.deepEqual(files.get(record.fileId), original);
    assert.equal(files.get(plan.parts[0].fileId).length, 3);
    assert.notEqual(files.get(plan.parts[0].fileId)[0].chat_metadata.integrity, 'source-integrity');
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
