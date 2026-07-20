import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { BackupService } from '../modules/backups.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

test('matches an underscored Chinese-card backup by integrity and messages', async () => {
    const header = { chat_metadata: { integrity: 'same-chat' }, user_name: 'unused', character_name: 'unused' };
    const messages = [{ name: 'User', mes: '你好', is_user: true }, { name: '角色', mes: '你好。', is_user: false }];
    const jsonl = [header, ...messages].map(value => JSON.stringify(value)).join('\n');
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
        listBackups: async () => [
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
        ],
        downloadBackup: async () => new Response(jsonl),
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
});
