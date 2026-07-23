import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    createChatSnapshot,
    createTextSnapshot,
    promptContentToText,
} from '../modules/prompt-common/snapshot.js';
import { countPromptMessageTokens } from '../modules/prompt-common/token-counter.js';
import {
    clampFloatingPosition,
    placeFloatingPanel,
    resizeFloatingPanel,
} from '../modules/prompt-viewer/ui.js';
import { groupAdjacentPromptNodes } from '../modules/prompt-viewer/view-model.js';
import { nextSearchIndex } from '../modules/prompt-viewer/search.js';
import { groupWorldInfoSections } from '../modules/world-info-control/order.js';
import {
    WorldInfoControlStore,
    getWorldInfoControlChatKey,
} from '../modules/world-info-control/store.js';
import {
    WorldInfoPromptAdapter,
    worldControlId,
} from '../modules/world-info-control/world-info.js';

const countTokens = async text => String(text).length;

test('最终提示词快照保持真实消息顺序和角色', async () => {
    const snapshot = await createChatSnapshot({
        chat: [
            { role: 'system', content: '系统' },
            { role: 'user', content: '用户' },
        ],
        countMessageTokens: message => countTokens(message.content),
    });

    assert.deepEqual(snapshot.finalNodes.map(node => node.role), ['system', 'user']);
    assert.deepEqual(snapshot.finalNodes.map(node => node.content), ['系统', '用户']);
    assert.equal(snapshot.totalTokens, 4);
});

test('多模态消息转换为可读文本但保留 Token 计算入口', async () => {
    const message = {
        role: 'user',
        content: [
            { type: 'text', text: '描述' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
        ],
    };
    assert.equal(promptContentToText(message.content), '描述\n[图片]');
    const snapshot = await createChatSnapshot({
        chat: [message],
        countMessageTokens: async () => 99,
    });
    assert.equal(snapshot.finalNodes[0].tokenCount, 99);
});

test('文本补全只保存最终合并字符串', async () => {
    const snapshot = await createTextSnapshot({ prompt: '完整提示词', countTokens });
    assert.equal(snapshot.api, 'text-completion');
    assert.equal(snapshot.finalNodes[0].content, '完整提示词');
    assert.equal(snapshot.totalTokens, 5);
});

test('连续相同角色只影响展示分组不改变消息', () => {
    const groups = groupAdjacentPromptNodes([
        { id: '1', role: 'system', tokenCount: 2 },
        { id: '2', role: 'system', tokenCount: 3 },
        { id: '3', role: 'user', tokenCount: 4 },
    ]);
    assert.deepEqual(groups.map(group => [group.role, group.nodes.length, group.tokenCount]), [
        ['system', 2, 5],
        ['user', 1, 4],
    ]);
});

test('世界书排除状态按聊天隔离', () => {
    const store = new WorldInfoControlStore();
    store.setChatKey('character:1:a');
    store.setExcluded('world:书:1', true);
    store.setChatKey('character:1:b');
    assert.equal(store.isExcluded('world:书:1'), false);
    store.setChatKey('character:1:a');
    assert.equal(store.isExcluded('world:书:1'), true);
});

test('世界书适配器在扫描前移除临时关闭条目', () => {
    const store = new WorldInfoControlStore();
    store.setChatKey('character:1:a');
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

test('世界书扫描结果保留条目标识和处理后正文', () => {
    const store = new WorldInfoControlStore();
    store.setChatKey('character:1:a');
    const adapter = new WorldInfoPromptAdapter({
        store,
        processEntry: entry => `处理:${entry.content}`,
    });
    adapter.captureActivatedEntries({
        activated: {
            entries: new Map([['entry', { world: '书一', uid: 7, content: '正文', order: 20 }]]),
        },
    });
    const [entry] = adapter.getActivatedEntries();
    assert.equal(worldControlId(entry), 'world:书一:7');
    assert.equal(entry.processedContent, '处理:正文');
});

test('世界书按来源分区并在分区内沿用酒馆文件名排序', () => {
    const sections = groupWorldInfoSections([
        { world: '!! Table.custom', sourceType: 'global', uid: 1, position: 0, order: 30 },
        { world: '__SSVGG', sourceType: 'global', uid: 2, position: 1, order: 10 },
        { world: '__SSVGG', sourceType: 'global', uid: 3, position: 0, order: 20 },
        { world: '角色书', sourceType: 'character', uid: 4, position: 0, order: 40 },
        { world: '__SSVGG', sourceType: 'global', uid: 5, position: 0, order: 5 },
    ]);
    assert.deepEqual(sections.map(section => section.label), ['角色世界书', '全局世界书']);
    assert.deepEqual(sections[1].groups.map(group => group.name), ['__SSVGG', '!! Table.custom']);
    assert.deepEqual(sections[1].groups[0].entries.map(entry => entry.uid), [5, 3, 2]);
});

test('世界书适配器保留酒馆加载事件中的来源分类', () => {
    const store = new WorldInfoControlStore();
    const adapter = new WorldInfoPromptAdapter({ store });
    const characterEntry = { world: '角色书', uid: 1, content: '角色' };
    const globalEntry = { world: '全局书', uid: 2, content: '全局' };
    adapter.filterLoadedEntries({
        characterLore: [characterEntry],
        globalLore: [globalEntry],
        chatLore: [],
        personaLore: [],
    });
    adapter.captureActivatedEntries({
        sortedEntries: [characterEntry, globalEntry],
        activated: { entries: new Set([characterEntry, globalEntry]) },
    });
    assert.deepEqual(
        adapter.getActivatedEntries().map(entry => entry.sourceType),
        ['character', 'global'],
    );
});

test('世界书 Token 更新不替换条目列表', () => {
    const store = new WorldInfoControlStore();
    const changes = [];
    const entry = { controlId: 'world:书:1', tokenCount: null };
    store.subscribe(change => changes.push(change));
    store.setEntries([entry]);
    store.setTokenCounts(new Map([['world:书:1', 42]]));
    assert.equal(store.getEntries()[0], entry);
    assert.equal(entry.tokenCount, 42);
    assert.deepEqual(changes, ['entries', 'tokens']);
});

test('聊天标识区分角色和群聊', () => {
    assert.equal(
        getWorldInfoControlChatKey({ characterId: 3, groupId: null, chatId: 'a' }),
        'character:3:a',
    );
    assert.equal(
        getWorldInfoControlChatKey({ characterId: 3, groupId: 'g1', chatId: 'b' }),
        'group:g1:b',
    );
});

test('提示词 Token 计算继续支持工具调用', async () => {
    const toolCalls = [{ id: 'call-1', function: { name: 'search' } }];
    const count = await countPromptMessageTokens({
        role: 'assistant',
        content: '',
        tool_calls: toolCalls,
    }, countTokens);
    assert.equal(count, JSON.stringify(toolCalls).length);
});

test('提示词查看器同时支持主动预览和正式请求捕获', async () => {
    const source = await readFile(
        new URL('../modules/prompt-viewer/module.js', import.meta.url),
        'utf8',
    );
    assert.match(source, /CHAT_COMPLETION_SETTINGS_READY/);
    assert.match(source, /GENERATE_AFTER_DATA/);
    assert.match(source, /GENERATION_STARTED/);
    assert.doesNotMatch(source, /context\.generate|WORLDINFO_/);
});

test('提示词查看器读取最终请求 messages 并忽略文本 dry-run', async () => {
    const source = await readFile(
        new URL('../modules/prompt-viewer/capture.js', import.meta.url),
        'utf8',
    );
    assert.match(source, /payload\?\.messages/);
    assert.match(source, /chat:\s*payload\.messages/);
    assert.match(source, /dryRun === true/);
    assert.match(source, /Generate\('normal', \{ automatic_trigger: true \}\)/);
    assert.match(source, /stopGeneration\(\)/);
    assert.match(source, /this\.previewing/);
    assert.match(source, /#stageDraft\(\)/);
    assert.match(source, /draft\.chat\.splice/);
    assert.doesNotMatch(source, /sendMessageAsUser/);
    assert.doesNotMatch(source, /payload\?\.chat/);
});

test('世界书扫描包含输入框草稿且不触发完整生成', async () => {
    const source = await readFile(
        new URL('../modules/world-info-control/scanner.js', import.meta.url),
        'utf8',
    );
    assert.match(source, /#send_textarea/);
    assert.match(source, /getWorldInfoPrompt/);
    assert.match(source, /getMaxPromptTokens/);
    assert.match(source, /slice\(-MAX_SCAN_DEPTH\)/);
    assert.match(source, /setStatus\(complete \? 'ready' : 'scanning'\)/);
    assert.match(source, /if \(complete\) this\.#scheduleTokenCounts/);
    assert.doesNotMatch(source, /context\.generate/);
});

test('世界书正式过滤和预览扫描共用同一排除规则', async () => {
    const source = await readFile(
        new URL('../modules/world-info-control/world-info.js', import.meta.url),
        'utf8',
    );
    assert.doesNotMatch(source, /isPreviewing|beginPreview|endPreview/);
    assert.match(source, /filterLoadedEntries/);
});

test('搜索定位支持首尾循环', () => {
    assert.equal(nextSearchIndex(-1, 3, 1), 0);
    assert.equal(nextSearchIndex(0, 3, -1), 2);
    assert.equal(nextSearchIndex(2, 3, 1), 0);
});

test('提示词角色组仅在多条消息时增加消息折叠层', async () => {
    const source = await readFile(
        new URL('../modules/prompt-viewer/ui.js', import.meta.url),
        'utf8',
    );
    assert.match(source, /group\.nodes\.length === 1/);
    assert.match(source, /group\.nodes\.length > 1/);
    assert.match(source, /prompt-control-single-message-body/);
    assert.match(source, /else \{\s*group\.nodes\.forEach/s);
    assert.match(source, /#\$\{node\.sendIndex \+ 1\} 消息/);
    assert.doesNotMatch(source, /#\$\{index \+ 1\} 消息/);
});

test('提示词悬浮面板始终限制在视口内', () => {
    assert.deepEqual(
        clampFloatingPosition(
            { x: -20, y: 900 },
            { width: 42, height: 42 },
            { width: 1000, height: 800 },
        ),
        { x: 8, y: 750 },
    );
    assert.deepEqual(
        placeFloatingPanel(
            { left: 4, top: 730, bottom: 772, width: 42 },
            { width: 400, height: 300 },
            { width: 1000, height: 800 },
        ),
        { left: 8, top: 422 },
    );
});

test('提示词面板四边调整不会越出视口', () => {
    assert.deepEqual(
        resizeFloatingPanel(
            { left: 200, top: 180, width: 500, height: 360 },
            'nw',
            { x: -300, y: -300 },
            { width: 1000, height: 800 },
        ),
        { left: 8, top: 8, width: 692, height: 532 },
    );
});
