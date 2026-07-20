import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { BackupService } from '../modules/backups.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

test('matches and caches an underscored Chinese-card backup by integrity', async () => {
    const header = { chat_metadata: { integrity: 'same-chat' }, user_name: 'unused', character_name: 'unused' };
    const messages = [{ name: 'User', mes: '你好', is_user: true }, { name: '角色', mes: '你好。', is_user: false }];
    const jsonl = [header, ...messages].map(value => JSON.stringify(value)).join('\n');
    let listCount = 0;
    let downloadCount = 0;
    const api = {
        sanitizeFileName: async value => value,
        getCharacterChats: async () => [{
            file_name: '聊天.jsonl',
            file_size: '1 KiB',
            chat_items: 2,
            last_mes: '2026-01-01T00:00:00.000Z',
            chat_metadata: header.chat_metadata,
        }],
        getCharacterChat: async () => [header, ...messages],
        listBackups: async () => {
            listCount++;
            return [
                {
                    file_name: 'chat____20260101-000000.jsonl',
                    file_size: '1 KiB',
                    chat_items: 2,
                    last_mes: '2026-01-01T00:00:00.000Z',
                },
                {
                    file_name: 'chat_____20260101-000001.jsonl',
                    file_size: '1 KiB',
                    chat_items: 2,
                    last_mes: '2026-01-01T00:00:01.000Z',
                },
            ];
        },
        downloadBackup: async () => {
            downloadCount++;
            return new Response(jsonl);
        },
    };
    const service = new BackupService(api);
    const matches = await service.find({
        ownerType: 'character',
        ownerId: '角色.png',
        ownerName: '角色',
        fileId: '聊天',
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].status, 'matched');
    await service.find({
        ownerType: 'character',
        ownerId: '角色.png',
        ownerName: '角色',
        fileId: '聊天',
    });
    assert.equal(listCount, 1);
    assert.equal(downloadCount, 1);
});

test('falls back to message comparison for legacy backups without integrity', async () => {
    const header = { chat_metadata: {}, character_name: '角色' };
    const messages = [{ name: 'User', mes: '旧聊天', is_user: true }];
    const jsonl = [header, ...messages].map(value => JSON.stringify(value)).join('\n');
    const api = {
        sanitizeFileName: async value => value,
        getCharacterChats: async () => [{
            file_name: '聊天.jsonl',
            chat_items: 1,
            chat_metadata: {},
        }],
        getCharacterChat: async () => [header, ...messages],
        listBackups: async () => [{
            file_name: 'chat____20260101-000000.jsonl',
            chat_items: 1,
            last_mes: '2026-01-01T00:00:00.000Z',
        }],
        downloadBackup: async () => new Response(jsonl),
    };
    const matches = await new BackupService(api).find({
        ownerType: 'character',
        ownerId: '角色.png',
        ownerName: '角色',
        fileId: '聊天',
        messageCount: 1,
    });

    assert.equal(matches.length, 1);
    assert.equal(matches[0].status, 'matched');
    assert.equal(matches[0].reason, '消息完整匹配');
});
