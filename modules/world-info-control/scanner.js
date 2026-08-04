import { MAX_SCAN_DEPTH, world_info_include_names } from '/scripts/world-info.js';
import { getMaxPromptTokens } from '/script.js';

import { getWorldInfoControlChatKey } from './store.js';
import { worldControlId } from './world-info.js';

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
        this.tokenTimer = null;
        this.tokenRevision = 0;
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) {
            this.revision += 1;
            this.tokenRevision += 1;
            clearTimeout(this.tokenTimer);
        }
    }

    /**
     * 扫描当前聊天和输入框草稿
     * @returns {Promise<void>} 扫描完成
     */
    async refresh() {
        if (!this.enabled) return;
        if (this.refreshTask) {
            this.pendingRefresh = true;
            this.#setScanningStatus();
            return this.refreshTask;
        }
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
        // 手动与初始化扫描只消费本次干扫描事件，不沿用上次真实发送结果
        this.adapter.reset();
        this.refreshTask = this.#scan(context, revision).catch(error => {
            if (revision === this.revision) this.store.setStatus('error');
            console.error('[酒馆工具箱] 世界书扫描失败', error);
            throw error;
        }).finally(() => {
            this.refreshTask = null;
            if (this.pendingRefresh && this.enabled) {
                this.pendingRefresh = false;
                void this.refresh();
            }
        });
        return this.refreshTask;
    }

    /**
     * 根据是否已有稳定结果显示当前扫描状态
     */
    #setScanningStatus() {
        this.store.setStatus(this.store.getEntries().length ? 'scanning' : 'loading');
    }

    isScanning() {
        return Boolean(this.refreshTask);
    }

    async #scan(context, revision) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const fields = context.getCharacterCardFields();
        const scanChat = buildScanChat(context);
        await context.getWorldInfoPrompt(
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
        );
        if (revision !== this.revision) return;
        await this.syncFromAdapter();
    }

    /**
     * 将最近一次原生扫描结果同步到面板
     */
    async syncFromAdapter({ complete = true } = {}) {
        const context = this.getContext();
        const chatKey = getWorldInfoControlChatKey(context);
        const activatedEntries = this.adapter.getActivatedEntries()
            .filter(entry => String(entry.processedContent ?? '').trim());
        const entries = activatedEntries.map(entry => ({
            ...entry,
            controlId: worldControlId(entry),
            tokenCount: null,
        }));
        this.store.setEntries(entries);
        this.store.setStatus(complete ? 'ready' : 'scanning');
        if (complete) this.#scheduleTokenCounts(context, chatKey, entries);
    }

    // Token 统计不参与扫描完成判定，避免大量条目阻塞触发结果
    #scheduleTokenCounts(context, chatKey, entries) {
        clearTimeout(this.tokenTimer);
        const revision = ++this.tokenRevision;
        if (!entries.length) return;
        this.tokenTimer = setTimeout(async () => {
            try {
                const counts = await Promise.all(entries.map(entry => (
                    context.getTokenCountAsync(entry.processedContent ?? '')
                )));
                if (!this.enabled || revision !== this.tokenRevision) return;
                if (getWorldInfoControlChatKey(this.getContext()) !== chatKey) return;
                this.store.setTokenCounts(new Map(entries.map((entry, index) => (
                    [entry.controlId, counts[index]]
                ))));
            } catch (error) {
                console.warn('[酒馆工具箱] 世界书条目 Token 统计失败', error);
            }
        }, 800);
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
