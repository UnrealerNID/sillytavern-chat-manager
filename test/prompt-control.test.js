import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    PromptSnapshotStore,
    createChatSnapshot,
    createTextSnapshot,
    flattenStructuredMessages,
    getPromptChatKey,
    groupContributionsBySource,
    groupWorldInfoContributions,
} from '../modules/prompt-control/snapshot.js';
import { countPromptMessageTokens } from '../modules/prompt-control/token-counter.js';
import {
    clampFloatingPosition,
    placeFloatingPanel,
    resizeFloatingPanel,
} from '../modules/prompt-control/ui.js';
import {
    createPromptDisplayNodes,
    createSourceTree,
    groupAdjacentPromptNodes,
} from '../modules/prompt-control/view-model.js';
import { nextSearchIndex } from '../modules/prompt-control/search.js';
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
    assert.deepEqual(
        createPromptDisplayNodes(snapshot).map(item => item.content),
        ['主提示词', '世界书内容', '你好'],
    );
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
            content: '{{天气}}',
            processedContent: '晴天',
            position: 0,
            order: 20,
        }],
    });
    const entry = snapshot.contributions.find(item => item.id === 'world:测试世界书:7');

    assert.equal(entry.controlId, 'world:测试世界书:7');
    assert.equal(entry.controlLevel, 'source');
    assert.equal(entry.finalNodeId, snapshot.finalNodes[0].id);
    assert.equal(entry.tokenCount, 2);
    assert.equal(entry.worldName, '测试世界书');
    assert.equal(entry.content, '晴天');
    assert.equal(entry.insertionPosition, '角色定义前');
    assert.equal(entry.insertionOrder, 20);
});

test('插在上下文中的世界书仍按来源归类并从上下文项中分离', async () => {
    const snapshot = await createChatSnapshot({
        chat: [{ role: 'system', content: '普通上下文\n处理后的世界书' }],
        messages: collection(message(
            'chatHistory-1',
            'system',
            '普通上下文\n处理后的世界书',
        )),
        countTokens,
        dryRun: true,
        worldEntries: [{
            uid: 9,
            world: '测试世界书',
            comment: '深度条目',
            content: '{{模板}}',
            processedContent: '处理后的世界书',
            position: 4,
            depth: 3,
            role: 0,
            order: 80,
        }],
    });
    const context = snapshot.contributions.find(item => item.sourceType === 'chat');
    const world = snapshot.contributions.find(item => item.id === 'world:测试世界书:9');

    assert.equal(context.content, '普通上下文');
    assert.equal(world.sourceType, 'worldInfo');
    assert.equal(world.content, '处理后的世界书');
    assert.equal(world.insertionPosition, '上下文深度 3');
    assert.equal(world.sendIndex, 0);
});

test('纯变量条目不显示而锚点正文只保留一次', async () => {
    const snapshot = await createChatSnapshot({
        chat: [{ role: 'system', content: '预设开头\n锚点正文' }],
        messages: collection(message('main', 'system', '预设开头\n锚点正文')),
        countTokens,
        dryRun: true,
        worldEntries: [
            {
                uid: 10,
                world: '变量世界书',
                comment: '设置变量',
                content: '{{setvar::场景::夜晚}}',
                processedContent: '  \n',
                position: 4,
            },
            {
                uid: 11,
                world: '变量世界书',
                comment: '锚点内容',
                content: '锚点正文',
                processedContent: '锚点正文',
                position: 7,
                outletName: '场景锚点',
            },
        ],
    });
    const contents = snapshot.contributions.map(item => item.content);

    assert.equal(snapshot.contributions.some(item => item.id === 'world:变量世界书:10'), false);
    assert.equal(contents.filter(content => content.includes('锚点正文')).length, 1);
    assert.equal(
        snapshot.contributions.find(item => item.id === 'world:变量世界书:11').insertionPosition,
        '出口 场景锚点',
    );
});

test('排除状态按聊天隔离且不写入快照', () => {
    const store = new PromptSnapshotStore();
    store.setChatKey('character:1:chat-a');
    store.setExcluded('final:a', true);
    store.setChatKey('character:1:chat-b');
    assert.equal(store.isExcluded('final:a'), false);
    store.setChatKey('character:1:chat-a');
    assert.equal(store.isExcluded('final:a'), true);
    store.setExclusions(['final:a', 'final:b'], false);
    assert.equal(store.isExcluded('final:a'), false);
    assert.equal(store.isExcluded('final:b'), false);
    store.setExclusions(['final:a', 'final:b'], true);
    assert.equal(store.isExcluded('final:b'), true);
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

test('提示词消息按查看器规则分别计算文本与多模态内容', async () => {
    const count = await countPromptMessageTokens({
        role: 'user',
        content: [
            { type: 'text', text: '四字文本' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,x', detail: 'auto' } },
            { type: 'video_url', video_url: { url: 'video' } },
        ],
    }, countTokens, async () => ({ width: 512, height: 512 }));
    assert.equal(count, 1089);
});

test('空助手消息按查看器规则计算工具调用', async () => {
    const toolCalls = [{ id: 'call-1', function: { name: 'search' } }];
    const count = await countPromptMessageTokens({
        role: 'assistant',
        content: '',
        tool_calls: toolCalls,
    }, countTokens);
    assert.equal(count, JSON.stringify(toolCalls).length);
});

test('自定义标识归入预设且不直接显示内部哈希', async () => {
    const snapshot = await createChatSnapshot({
        chat: [{ role: 'system', content: '内容' }],
        messages: collection(message('adbe0f3a-e6c6-4532-b274-81a02be7fecf', 'system', '内容')),
        countTokens,
        dryRun: true,
    });
    assert.equal(snapshot.contributions[0].sourceName, '其他提示词');
    assert.equal(snapshot.contributions[0].sourceType, 'preset');
});

test('提示词视图只合并最终顺序中连续且相同的角色', () => {
    const groups = groupAdjacentPromptNodes([
        { id: 's1', role: 'system', content: '系统一', tokenCount: 3 },
        { id: 's2', role: 'system', content: '系统二', tokenCount: 4 },
        { id: 'u1', role: 'user', content: '用户', tokenCount: 2 },
        { id: 's3', role: 'system', content: '系统三', tokenCount: 5 },
    ]);

    assert.deepEqual(groups.map(group => ({
        role: group.role,
        ids: group.nodes.map(node => node.id),
        tokenCount: group.tokenCount,
    })), [
        { role: 'system', ids: ['s1', 's2'], tokenCount: 7 },
        { role: 'user', ids: ['u1'], tokenCount: 2 },
        { role: 'system', ids: ['s3'], tokenCount: 5 },
    ]);
});

test('世界书来源按世界书分组且合并结果置于末尾', () => {
    const items = [
        { id: 'combined', sourceType: 'worldInfo', worldName: '', sourceName: '角色定义前世界书' },
        { id: 'b', sourceType: 'worldInfo', worldName: '世界书乙', sourceName: '条目乙' },
        { id: 'a', sourceType: 'worldInfo', worldName: '世界书甲', sourceName: '条目甲' },
    ];
    const groups = groupWorldInfoContributions(items);

    assert.deepEqual(groups.map(group => ({
        id: group.id,
        items: group.items.map(item => item.id),
    })), [
        { id: '世界书甲', items: ['a'] },
        { id: '世界书乙', items: ['b'] },
        { id: 'combined', items: ['combined'] },
    ]);
    const [source] = createSourceTree(items);
    assert.equal(source.items.length, 0);
    assert.deepEqual(
        source.children.map(group => group.items.map(item => item.id)),
        [['a'], ['b'], ['combined']],
    );
});

test('普通来源沿用同一来源树且直接保留来源项', () => {
    const items = [{ id: 'main', sourceType: 'preset', sourceName: '主提示词' }];
    const [source] = createSourceTree(items);

    assert.equal(source.children.length, 0);
    assert.equal(source.items[0], items[0]);
});

test('搜索定位支持首次定位与首尾循环', () => {
    assert.equal(nextSearchIndex(-1, 3, 1), 0);
    assert.equal(nextSearchIndex(-1, 3, -1), 2);
    assert.equal(nextSearchIndex(2, 3, 1), 0);
    assert.equal(nextSearchIndex(0, 3, -1), 2);
    assert.equal(nextSearchIndex(0, 0, 1), -1);
});

test('提示词预览走完整装配链路并在网络请求前停止', async () => {
    const [capture, moduleSource] = await Promise.all([
        readFile(new URL('../modules/prompt-control/capture.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/prompt-control/module.js', import.meta.url), 'utf8'),
    ]);

    assert.match(capture, /context\.generate\('normal'\)/);
    assert.doesNotMatch(capture, /context\.generate\('normal', \{\}, true\)/);
    assert.match(capture, /this\.getContext\(\)\.stopGeneration\(\)/);
    assert.match(moduleSource, /CHAT_COMPLETION_SETTINGS_READY/);
    assert.match(moduleSource, /GENERATE_AFTER_DATA/);
});

test('悬浮气泡和面板移动后始终保留在视口内', () => {
    assert.deepEqual(
        clampFloatingPosition({ x: -20, y: 900 }, { width: 42, height: 42 }, { width: 1000, height: 800 }),
        { x: 8, y: 750 },
    );
    assert.deepEqual(
        placeFloatingPanel(
            { left: 4, top: 730, right: 46, bottom: 772, width: 42, height: 42 },
            { width: 400, height: 300 },
            { width: 1000, height: 800 },
        ),
        { left: 8, top: 422 },
    );
});

test('面板四边与四角均可调整且不会越出视口', () => {
    const bounds = { left: 200, top: 180, width: 500, height: 360 };
    assert.deepEqual(
        resizeFloatingPanel(bounds, 'nw', { x: -300, y: -300 }, { width: 1000, height: 800 }),
        { left: 8, top: 8, width: 692, height: 532 },
    );
    assert.deepEqual(
        resizeFloatingPanel(bounds, 'se', { x: 500, y: 500 }, { width: 1000, height: 800 }),
        { left: 200, top: 180, width: 792, height: 612 },
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
