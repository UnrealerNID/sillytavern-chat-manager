import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { BackupService } from '../modules/chat-files/backups/backups.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

test('backup features never call the race-prone native backup name endpoints', async () => {
    const sources = await Promise.all([
        readFile(new URL('../modules/chat-files/api.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/chat-files/backups/backups.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/chat-files/backups/data-maid-enhancer.js', import.meta.url), 'utf8'),
        readFile(new URL('../index.js', import.meta.url), 'utf8'),
    ]);
    const source = sources.join('\n');
    assert.doesNotMatch(source, /\/api\/backups\/chat\/get/);
    assert.doesNotMatch(source, /\/api\/backups\/chat\/download/);
    assert.match(source, /\/api\/data-maid\/report/);
    assert.match(source, /readDataMaidFile/);
});

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
        createDataMaidReport: async () => {
            listCount++;
            return { token: 'report-1', report: { chatBackups: [
                { name: 'chat____20260101-000000.jsonl', size: 1024, mtime: Date.parse('2026-01-01T00:00:00.000Z'), hash: 'first' },
                { name: 'chat_____20260101-000001.jsonl', size: 1024, mtime: Date.parse('2026-01-01T00:00:01.000Z'), hash: 'second' },
            ] } };
        },
        readDataMaidFile: async () => {
            downloadCount++;
            return new Response(jsonl);
        },
        finalizeDataMaidReport: async () => {},
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
    service.resultCache.set('expired', { expiresAt: 0, matches: [] });
    await service.find({
        ownerType: 'character',
        ownerId: '角色.png',
        ownerName: '角色',
        fileId: '聊天',
        lastMessageAt: '2026-01-01T00:00:01.000Z',
    });
    assert.equal(downloadCount, 2);
    assert.equal(service.resultCache.has('expired'), false);
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
        createDataMaidReport: async () => ({ token: 'report-2', report: { chatBackups: [{
            name: 'chat____20260101-000000.jsonl', size: 1024,
            mtime: Date.parse('2026-01-01T00:00:00.000Z'), hash: 'legacy',
        }] } }),
        readDataMaidFile: async () => new Response(jsonl),
        finalizeDataMaidReport: async () => {},
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

test('emits candidate rows before loading the source or scanning backup files', async () => {
    const header = { chat_metadata: { integrity: 'same-chat' } };
    const message = { name: '角色', mes: '测试消息' };
    const jsonl = [header, message].map(value => JSON.stringify(value)).join('\n');
    let releaseSlow;
    const slow = new Promise(resolve => { releaseSlow = resolve; });
    let releaseSource;
    const source = new Promise(resolve => { releaseSource = resolve; });
    const api = {
        sanitizeFileName: async value => value,
        getCharacterChats: async () => [{ file_name: '聊天.jsonl', chat_items: 1, chat_metadata: header.chat_metadata }],
        getCharacterChat: async () => {
            await source;
            return [header, message];
        },
        createDataMaidReport: async () => ({ token: 'report-3', report: { chatBackups: [
            { name: 'chat____20260101-000000.jsonl', size: 1024, mtime: Date.parse('2026-01-01T00:00:00.000Z'), hash: 'first' },
            { name: 'chat____20260101-000001.jsonl', size: 1024, mtime: Date.parse('2026-01-01T00:00:01.000Z'), hash: 'second' },
        ] } }),
        readDataMaidFile: async (_token, hash) => {
            if (hash === 'second') await slow;
            return new Response(jsonl);
        },
        finalizeDataMaidReport: async () => {},
    };
    const emitted = [];
    let resolveFirstMatch;
    const firstMatch = new Promise(resolve => { resolveFirstMatch = resolve; });
    let completed = false;
    let resolveCandidates;
    const candidatesReady = new Promise(resolve => { resolveCandidates = resolve; });
    const finding = new BackupService(api).find({
        ownerType: 'character',
        ownerId: '角色.png',
        ownerName: '角色',
        fileId: '聊天',
        messageCount: 1,
    }, {
        onCandidates: candidates => resolveCandidates(candidates.map(item => item.file_name)),
        onResult: (_candidate, match) => {
            if (!match) return;
            emitted.push(match.file_name);
            resolveFirstMatch();
        },
    });
    finding.then(() => { completed = true; });

    assert.deepEqual(await candidatesReady, [
        'chat____20260101-000001.jsonl',
        'chat____20260101-000000.jsonl',
    ]);
    assert.equal(completed, false);
    releaseSource();
    await firstMatch;
    assert.deepEqual(emitted, ['chat____20260101-000000.jsonl']);
    assert.equal(completed, false);

    releaseSlow();
    const matches = await finding;
    assert.equal(matches.length, 2);
    assert.equal(emitted.length, 2);
});

test('disposing an in-flight backup catalog finalizes its late token without restoring cache', async () => {
    let releaseReport;
    const reportReady = new Promise(resolve => {
        releaseReport = resolve;
    });
    const finalized = [];
    const service = new BackupService({
        createDataMaidReport: async () => {
            await reportReady;
            return {
                token: 'late-token',
                report: { chatBackups: [] },
            };
        },
        finalizeDataMaidReport: async token => finalized.push(token),
    });

    const listing = service.list();
    await service.dispose();
    releaseReport();

    await assert.rejects(listing, /备份目录读取已取消/);
    assert.deepEqual(finalized, ['late-token']);
    assert.equal(service.backupListCache, null);
    assert.equal(service.reportToken, '');
});

test('the shared backup catalog is owned by the service instead of a caller', async () => {
    let releaseReport;
    let receivedSignal;
    const reportReady = new Promise(resolve => {
        releaseReport = resolve;
    });
    const service = new BackupService({
        createDataMaidReport: async signal => {
            receivedSignal = signal;
            await reportReady;
            return {
                token: 'shared-token',
                report: { chatBackups: [] },
            };
        },
        finalizeDataMaidReport: async () => {},
    });
    const first = service.list();
    const second = service.list();
    releaseReport();

    assert.deepEqual(await first, []);
    assert.deepEqual(await second, []);
    assert.equal(receivedSignal, undefined);
    await service.dispose();
});

test('superseded backup reports remain valid until their active response is consumed', async () => {
    let reportNumber = 0;
    let releaseBlob;
    const blobReady = new Promise(resolve => {
        releaseBlob = resolve;
    });
    const finalized = [];
    const service = new BackupService({
        createDataMaidReport: async () => {
            reportNumber++;
            return {
                token: `report-${reportNumber}`,
                report: {
                    chatBackups: [{
                        name: 'chat_test_20260101-000000.jsonl',
                        size: 10,
                        mtime: 1,
                        hash: 'backup',
                    }],
                },
            };
        },
        readDataMaidFile: async () => ({
            blob: async () => {
                await blobReady;
                return new Blob(['backup']);
            },
        }),
        finalizeDataMaidReport: async token => finalized.push(token),
    });

    const [backup] = await service.list();
    const reading = service.readBlob(backup);
    service.backupListCache.expiresAt = 0;
    await service.list();
    assert.deepEqual(finalized, []);

    releaseBlob();
    await reading;
    assert.deepEqual(finalized, ['report-1']);

    await service.dispose();
    assert.deepEqual(finalized, ['report-1', 'report-2']);
});

test('failed backup report finalization remains tracked for a later retry', async () => {
    let finalizeAttempts = 0;
    const service = new BackupService({
        createDataMaidReport: async () => ({
            token: 'retry-token',
            report: { chatBackups: [] },
        }),
        finalizeDataMaidReport: async () => {
            finalizeAttempts++;
            if (finalizeAttempts === 1) throw new Error('temporary failure');
        },
    });

    await service.list();
    await service.dispose();
    assert.equal(service.reportLeases.has('retry-token'), true);

    await service.dispose();
    assert.equal(finalizeAttempts, 2);
    assert.equal(service.reportLeases.has('retry-token'), false);
});
