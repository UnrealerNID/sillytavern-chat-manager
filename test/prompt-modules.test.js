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
import {
    compareWorldInfoEntryOrder,
    groupWorldInfoSections,
} from '../modules/world-info-control/order.js';
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

test('世界书排除状态按世界书保存并跨聊天生效', () => {
    const store = new WorldInfoControlStore();
    store.setChatKey('character:1:a');
    store.setExcluded('world:书:1', true);
    store.setChatKey('character:1:b');
    assert.equal(store.isExcluded('world:书:1'), true);
    assert.equal(store.isExcluded('world:另一书:1'), false);
});

test('世界书排除状态可持久化并在运行时重置后保留', () => {
    let saved = null;
    const store = new WorldInfoControlStore({
        exclusions: {
            书: ['1'],
        },
        onExclusionsChange: exclusions => { saved = exclusions; },
    });
    store.setChatKey('character:1:a');
    assert.equal(store.isExcluded('world:书:1'), true);
    store.resetRuntime();
    assert.equal(store.isExcluded('world:书:1'), true);
    store.setExcluded('world:书:2', true);
    assert.deepEqual(saved, {
        书: ['1', '2'],
    });
});

test('世界书排除统计和恢复只作用于当前加载的世界书', () => {
    const store = new WorldInfoControlStore({
        exclusions: {
            当前书: ['1'],
            其他书: ['2'],
        },
    });
    store.setEntries([], new Set(['当前书']));
    assert.deepEqual(Array.from(store.getRelevantExclusions()), ['world:当前书:1']);
    store.clearLoaded();
    assert.equal(store.isExcluded('world:当前书:1'), false);
    assert.equal(store.isExcluded('world:其他书:2'), true);
});

test('世界书适配器只在正式扫描前移除关闭条目', () => {
    const store = new WorldInfoControlStore();
    store.setExcluded('world:书一:2', true);
    const adapter = new WorldInfoPromptAdapter({ store });
    const productionPayload = {
        globalLore: [
            { world: '书一', uid: 1 },
            { world: '书一', uid: 2 },
        ],
        characterLore: [],
        chatLore: [],
        personaLore: [],
    };
    adapter.filterLoadedEntries(productionPayload);
    assert.deepEqual(productionPayload.globalLore.map(entry => entry.uid), [1]);
    assert.deepEqual(adapter.getActivatedEntries(), []);

    const previewPayload = structuredClone(productionPayload);
    previewPayload.globalLore.push({ world: '书一', uid: 2 });
    adapter.filterLoadedEntries(previewPayload, { applyExclusions: false });
    assert.deepEqual(previewPayload.globalLore.map(entry => entry.uid), [1, 2]);
    adapter.captureActivatedEntries({
        activated: { entries: new Set([previewPayload.globalLore[1]]) },
    });
    assert.equal(adapter.getActivatedEntries()[0].uid, 2);
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

test('世界书按来源分区并沿用酒馆加载顺序', () => {
    const sections = groupWorldInfoSections([
        { world: '!! Table.custom', sourceType: 'global', sourceOrder: 0, uid: 1, position: 0, order: 30 },
        { world: '__SSVGG', sourceType: 'global', sourceOrder: 1, uid: 2, position: 1, order: 10 },
        { world: '__SSVGG', sourceType: 'global', sourceOrder: 1, uid: 3, position: 0, order: 20 },
        { world: '角色书', sourceType: 'character', sourceOrder: 0, uid: 4, position: 0, order: 40 },
        { world: '__SSVGG', sourceType: 'global', sourceOrder: 1, uid: 5, position: 0, order: 5 },
    ]);
    assert.deepEqual(sections.map(section => section.label), ['角色世界书', '全局世界书']);
    assert.deepEqual(sections[1].groups.map(group => group.name), ['!! Table.custom', '__SSVGG']);
    assert.deepEqual(sections[1].groups[1].entries.map(entry => entry.uid), [5, 3, 2]);
});

test('世界书 outlet 与普通锚点使用各自的最终正文方向', () => {
    assert.ok(compareWorldInfoEntryOrder(
        { position: 0, order: 10 },
        { position: 0, order: 20 },
    ) < 0);
    assert.ok(compareWorldInfoEntryOrder(
        { position: 7, order: 20 },
        { position: 7, order: 10 },
    ) < 0);
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
    assert.match(source, /currentText\.startsWith\(draft\.text\)/);
    assert.doesNotMatch(source, /textarea\.value = ''/);
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
    assert.match(source, /#runRefreshLoop\(\)/);
    assert.match(source, /withTimeout/);
    assert.match(source, /status = 'ready'/);
    assert.match(source, /#setScanningStatus\(\)/);
    assert.match(source, /this\.adapter\.reset\(\)/);
    assert.match(source, /reuseTokenCount/);
    assert.doesNotMatch(source, /context\.generate/);
});

test('世界书面板在空结果和重复刷新时保持加载反馈', async () => {
    const [scanner, ui] = await Promise.all([
        readFile(new URL('../modules/world-info-control/scanner.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/world-info-control/ui.js', import.meta.url), 'utf8'),
    ]);
    assert.match(scanner, /this\.store\.getEntries\(\)\.length \? 'scanning' : 'loading'/);
    assert.match(ui, /status !== 'ready' && status !== 'loading' && status !== 'scanning'/);
    assert.match(ui, /status !== 'loading' && status !== 'scanning'/);
});

test('世界书预览与正式发送使用独立过滤模式', async () => {
    const source = await readFile(
        new URL('../modules/world-info-control/module.js', import.meta.url),
        'utf8',
    );
    assert.match(source, /applyExclusions: this\.generationActive \|\| !this\.scanner\.isPreviewActive\(\)/);
    assert.match(source, /GENERATION_STARTED/);
    assert.match(source, /GENERATION_ENDED/);
});

test('折叠面板仍接收真实发送产生的世界书扫描结果', async () => {
    const source = await readFile(
        new URL('../modules/world-info-control/module.js', import.meta.url),
        'utf8',
    );
    assert.match(source, /WORLDINFO_SCAN_DONE/);
    assert.match(source, /this\.scanner\.syncFromAdapter/);
    assert.match(source, /#finishGeneration/);
    assert.doesNotMatch(source, /if \(!this\.ui\.isOpen\(\)\) return/);
});

test('搜索定位支持首尾循环', () => {
    assert.equal(nextSearchIndex(-1, 3, 1), 0);
    assert.equal(nextSearchIndex(0, 3, -1), 2);
    assert.equal(nextSearchIndex(2, 3, 1), 0);
});

test('提示词搜索按具体命中文本定位', async () => {
    const source = await readFile(
        new URL('../modules/prompt-viewer/search.js', import.meta.url),
        'utf8',
    );
    assert.match(source, /mark\.dataset\.promptSearchHit = 'true'/);
    assert.match(source, /mark\[data-prompt-search-hit="true"\]/);
    assert.match(source, /inline: 'nearest'/);
    assert.doesNotMatch(source, /data-prompt-search-match/);
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
