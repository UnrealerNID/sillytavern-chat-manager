import { MAX_SCAN_DEPTH, world_info_include_names } from '/scripts/world-info.js';
import { getMaxPromptTokens } from '/script.js';

import { getWorldInfoControlChatKey } from './store.js';
import { worldControlId } from './world-info.js';

const SCAN_TIMEOUT_MS = 30_000;

/**
 * 使用酒馆原生世界书扫描器生成当前草稿对应的激活条目
 */
export class WorldInfoScanner {
    /**
     * @param {object} options 配置项
     * @param {()=>object} options.getContext 酒馆上下文读取器
     * @param {import('./store.js').WorldInfoControlStore} options.store 控制状态
     * @param {import('./world-info.js').WorldInfoPromptAdapter} options.adapter 世界书事件适配器
     */
    constructor({ getContext, store, adapter }) {
        this.getContext = getContext;
        this.store = store;
        this.adapter = adapter;
        this.enabled = false;
        this.refreshTask = null;
        this.pendingRefresh = false;
        this.revision = 0;
        this.previewRevision = 0;
        this.tokenTimer = null;
        this.tokenRevision = 0;
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) this.interrupt();
    }

    /**
     * 作废当前预览扫描和等待中的补充扫描
     */
    interrupt() {
        this.revision += 1;
        this.previewRevision = 0;
        this.pendingRefresh = false;
        this.tokenRevision += 1;
        clearTimeout(this.tokenTimer);
    }

    /**
     * 判断当前原生事件是否属于本模块的预览扫描
     * @returns {boolean} 是否正在预览
     */
    isPreviewActive() {
        return this.previewRevision !== 0;
    }

    /**
     * 扫描当前聊天和输入框草稿
     * @returns {Promise<void>} 扫描完成
     */
    async refresh() {
        if (!this.enabled) return;
        this.pendingRefresh = true;
        if (this.refreshTask) {
            this.#setScanningStatus();
            return this.refreshTask;
        }
        this.refreshTask = this.#runRefreshLoop().finally(() => {
            this.refreshTask = null;
        });
        return this.refreshTask;
    }

    // 重复刷新只保留一个待处理标记，当前扫描结束后读取最新上下文
    async #runRefreshLoop() {
        while (this.enabled && this.pendingRefresh) {
            this.pendingRefresh = false;
            await this.#refreshOnce();
        }
    }

    async #refreshOnce() {
        const context = this.getContext();
        this.store.setChatKey(getWorldInfoControlChatKey(context));
        if (context.characterId === undefined && !context.groupId) {
            this.store.setStatus('idle');
            return;
        }

        const revision = ++this.revision;
        this.tokenRevision += 1;
        clearTimeout(this.tokenTimer);
        this.#setScanningStatus();
        this.adapter.reset();
        try {
            await this.#scan(context, revision);
        } catch (error) {
            if (revision !== this.revision) return;
            this.store.setStatus(this.store.hasSnapshot() ? 'ready' : 'error');
            console.error('[酒馆工具箱] 世界书扫描失败', error);
            throw error;
        } finally {
            if (this.previewRevision === revision) this.previewRevision = 0;
        }
    }

    /**
     * 根据是否已有稳定结果显示当前扫描状态
     */
    #setScanningStatus() {
        this.store.setStatus(this.store.hasSnapshot() ? 'scanning' : 'loading');
    }

    async #scan(context, revision) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (!this.enabled || revision !== this.revision) return;
        this.previewRevision = revision;
        const fields = context.getCharacterCardFields();
        const scanChat = buildScanChat(context);
        await withTimeout(
            context.getWorldInfoPrompt(
                scanChat,
                getMaxPromptTokens(),
                true,
                {
                    personaDescription: fields.persona,
                    characterDescription: fields.description,
                    characterPersonality: fields.personality,
                    characterDepthPrompt: fields.charDepthPrompt,
                    scenario: fields.scenario,
                    creatorNotes: fields.creatorNotes,
                    trigger: 'normal',
                },
            ),
            SCAN_TIMEOUT_MS,
        );
        if (revision !== this.revision || this.pendingRefresh) return;
        await this.syncFromAdapter();
    }

    /**
     * 将最近一次原生扫描结果同步到面板
     * @param {object} [options] 同步选项
     * @param {string} [options.expectedChatKey] 结果所属聊天
     * @param {'ready'|'scanning'} [options.status] 同步后的面板状态
     */
    async syncFromAdapter({
        expectedChatKey = '',
        status = 'ready',
    } = {}) {
        const context = this.getContext();
        const chatKey = getWorldInfoControlChatKey(context);
        if (expectedChatKey && expectedChatKey !== chatKey) return;
        const previousEntries = new Map(this.store.getEntries().map(entry => [entry.controlId, entry]));
        const loadedWorlds = this.adapter.getLoadedWorlds();
        const activatedEntries = this.adapter.getActivatedEntries()
            .filter(entry => String(entry.processedContent ?? '').trim());
        const currentEntries = activatedEntries.map(entry => ({
            ...entry,
            controlId: worldControlId(entry),
            tokenCount: reuseTokenCount(previousEntries, entry),
        }));
        const excludedEntries = this.adapter.getExcludedEntries().map(entry => ({
            ...entry,
            controlId: worldControlId(entry),
            tokenCount: reuseTokenCount(previousEntries, entry),
        }));
        const entries = this.store.mergeSnapshotEntries(currentEntries, excludedEntries);
        this.store.setEntries(entries, loadedWorlds);
        this.store.setStatus(status);
        this.#scheduleTokenCounts(context, chatKey, entries);
    }

    // Token 统计不参与扫描完成判定，避免大量条目阻塞触发结果
    #scheduleTokenCounts(context, chatKey, entries) {
        clearTimeout(this.tokenTimer);
        const revision = ++this.tokenRevision;
        const pendingEntries = entries.filter(entry => !Number.isFinite(entry.tokenCount));
        if (!pendingEntries.length) return;
        this.tokenTimer = setTimeout(async () => {
            try {
                const counts = await Promise.all(pendingEntries.map(entry => (
                    context.getTokenCountAsync(entry.processedContent ?? '')
                )));
                if (!this.enabled || revision !== this.tokenRevision) return;
                if (getWorldInfoControlChatKey(this.getContext()) !== chatKey) return;
                this.store.setTokenCounts(new Map(pendingEntries.map((entry, index) => (
                    [entry.controlId, counts[index]]
                ))));
            } catch (error) {
                console.warn('[酒馆工具箱] 世界书条目 Token 统计失败', error);
            }
        }, 800);
    }
}

/**
 * 在条目标识和处理后正文均未变化时复用 Token
 * @param {Map<string,object>} previousEntries 上一轮条目
 * @param {object} entry 当前条目
 * @returns {number|null} 可复用的 Token 数
 */
function reuseTokenCount(previousEntries, entry) {
    const previous = previousEntries.get(worldControlId(entry));
    return previous?.processedContent === entry.processedContent
        ? previous.tokenCount
        : null;
}

/**
 * 限制原生扫描等待时间，底层任务迟到时由扫描版本阻止其写回
 * @param {Promise<unknown>} task 原生扫描任务
 * @param {number} timeoutMs 超时时间
 * @returns {Promise<void>} 等待结果
 */
async function withTimeout(task, timeoutMs) {
    let timeout;
    try {
        await Promise.race([
            task,
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error('世界书扫描超时')), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
}

function buildScanChat(context) {
    const messages = context.chat
        .slice(-MAX_SCAN_DEPTH)
        .filter(message => !message?.is_system)
        .map(message => ({
            name: message.name ?? '',
            text: String(message.mes ?? ''),
        }));
    const draft = String(document.querySelector('#send_textarea')?.value ?? '').trim();
    if (draft) messages.push({ name: context.name1 ?? '', text: draft });
    return messages
        .map(message => world_info_include_names && message.name
            ? `${message.name}: ${message.text}`
            : message.text)
        .reverse();
}
