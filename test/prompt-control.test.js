import assert from 'node:assert/strict';
import test from 'node:test';

import {
    PromptSnapshotStore,
    createChatSnapshot,
    createTextSnapshot,
    flattenStructuredMessages,
    getPromptChatKey,
    groupContributionsBySource,
} from '../modules/prompt-control/snapshot.js';
import { WorldInfoPromptAdapter } from '../modules/prompt-control/world-info.js';

const countTokens = async text => String(text).length;

test('结构化消息可映射到合并后的最终消息', async () => {
    const messages = collection(
        message('main', 'system', '主提示词'),
        message('worldInfoBefore', 'system', '世界书内容'),
        message('chatHistory-1', 'user', '你好'),
    );
    const snapshot = await createChatSnapshot({
        chat: [
            { role: 'system', content: '主提示词\n世界书内容' },
            { role: 'user', content: '你好' },
        ],
        messages,
        countTokens,
        dryRun: true,
    });

    assert.equal(snapshot.finalNodes.length, 2);
    assert.deepEqual(snapshot.finalNodes[0].contributionIds, ['main', 'worldInfoBefore']);
    assert.deepEqual(snapshot.finalNodes[1].contributionIds, ['chatHistory-1']);
    assert.equal(snapshot.contributions[0].controlLevel, 'locked');
    assert.equal(snapshot.contributions[2].controlLevel, 'final');
    assert.equal(snapshot.totalTokens, '主提示词\n世界书内容你好'.length);
});

test('重复来源标识仍生成不同的最终节点', async () => {
    const messages = collection(
        message('newChat', 'system', '示例开始'),
        message('newChat', 'system', '示例开始'),
    );
    const snapshot = await createChatSnapshot({
        chat: [
            { role: 'system', content: '示例开始' },
            { role: 'system', content: '示例开始' },
        ],
        messages,
        countTokens,
        dryRun: true,
    });

    assert.notEqual(snapshot.finalNodes[0].id, snapshot.finalNodes[1].id);
});

test('世界书条目保留独立控制标识和处理后文本', async () => {
    const messages = collection(message('worldInfoBefore', 'system', '合并世界书'));
    const snapshot = await createChatSnapshot({
        chat: [{ role: 'system', content: '合并世界书' }],
        messages,
        countTokens,
        dryRun: true,
        worldEntries: [{
            uid: 7,
            world: '测试世界书',
            comment: '天气',
            content: '晴天',
            position: 0,
            order: 20,
        }],
    });
    const entry = snapshot.contributions.find(item => item.id === 'world:测试世界书:7');

    assert.equal(entry.controlId, 'world:测试世界书:7');
    assert.equal(entry.controlLevel, 'source');
    assert.equal(entry.finalNodeId, snapshot.finalNodes[0].id);
    assert.equal(entry.tokenCount, 2);
});

test('排除状态按聊天隔离且不写入快照', () => {
    const store = new PromptSnapshotStore();
    store.setChatKey('character:1:chat-a');
    store.setExcluded('final:a', true);
    store.setChatKey('character:1:chat-b');
    assert.equal(store.isExcluded('final:a'), false);
    store.setChatKey('character:1:chat-a');
    assert.equal(store.isExcluded('final:a'), true);
    store.clearCurrent();
    assert.equal(store.isExcluded('final:a'), false);
});

test('世界书适配器只过滤当前聊天排除项', () => {
    const store = new PromptSnapshotStore();
    store.setChatKey('character:1:chat-a');
    store.setExcluded('world:书一:2', true);
    const adapter = new WorldInfoPromptAdapter({ store });
    const payload = {
        globalLore: [
            { world: '书一', uid: 1 },
            { world: '书一', uid: 2 },
        ],
        characterLore: [],
        chatLore: [],
        personaLore: [],
    };
    adapter.filterLoadedEntries(payload);
    assert.deepEqual(payload.globalLore.map(entry => entry.uid), [1]);
});

test('文本补全保留最终字符串和来源区段', async () => {
    const snapshot = await createTextSnapshot({
        prompt: '系统\n聊天',
        countTokens,
        dryRun: false,
        parts: [
            { id: 'main', sourceType: 'preset', sourceName: '主提示词', content: '系统' },
            { id: 'chat-0', sourceType: 'chat', sourceName: '聊天消息', content: '聊天' },
        ],
    });
    const groups = groupContributionsBySource(snapshot.contributions);
    assert.equal(snapshot.kind, 'actual');
    assert.equal(snapshot.totalTokens, 5);
    assert.deepEqual(groups.map(group => group.label), ['预设', '上下文消息']);
});

test('聊天标识区分角色和群聊', () => {
    assert.equal(
        getPromptChatKey({ characterId: 3, groupId: null, chatId: 'a' }),
        'character:3:a',
    );
    assert.equal(
        getPromptChatKey({ characterId: 3, groupId: 'g1', chatId: 'b' }),
        'group:g1:b',
    );
});

test('结构展开忽略空消息并保留集合顺序', () => {
    const root = collection(
        message('first', 'system', '一'),
        message('empty', 'system', ''),
        collection(message('second', 'user', '二')),
    );
    assert.deepEqual(
        flattenStructuredMessages(root).map(item => item.identifier),
        ['first', 'second'],
    );
});

function message(identifier, role, content) {
    return {
        identifier,
        role,
        content,
        tokens: content.length,
        getTokens() {
            return this.tokens;
        },
    };
}

function collection(...items) {
    return {
        collection: items,
        getCollection() {
            return this.collection;
        },
    };
}
