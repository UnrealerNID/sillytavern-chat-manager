import {
    getThumbnailUrl,
    isGenerating,
    saveSettingsDebounced,
    setActiveCharacter,
    setActiveGroup,
    system_avatar,
} from '/script.js';
import { openGroupById } from '/scripts/group-chats.js';
import { renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { accountStorage } from '/scripts/util/AccountStorage.js';
import { openWelcomeScreen } from '/scripts/welcome-screen.js';

import { waitForElement } from '../platform/dom.js';
import { EXTENSION_ID } from '../platform/extension-identity.js';
import { element } from '../shared/dom.js';
import { ChatManagerApi } from './api.js';
import { BackupService } from './backups/backups.js';
import { DataMaidEnhancer } from './backups/data-maid-enhancer.js';
import { createChatActions } from './chat/chat-actions.js';
import { openChatRecord } from './chat/chat-opener.js';
import { SplitService } from './chat/splitter.js';
import { TaskJournal } from './chat/task-journal.js';
import { ChatManagerUi } from './ui/ui.js';
import { NativeChatPanel } from './ui/native-chat-panel.js';
import { WelcomeRecentEnhancer } from './ui/welcome-recent.js';

/**
 * 装配并管理聊天文件模块的完整生命周期
 */
export class ChatFilesModule {
    /**
     * @param {object} options 配置项
     * @param {object} options.toolboxSettings 工具箱完整设置
     */
    constructor({ toolboxSettings }) {
        this.settings = toolboxSettings.modules.chatFiles;
        this.getContext = () => SillyTavern.getContext();
        this.recoveryChecked = false;
        this.enabled = false;
        this.initialized = false;
        this.eventBindings = [];
        this.eventsBound = false;
        this.entryController = null;
    }

    /**
     * 创建界面、原生注入与事件监听
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.initialized) return;
        const context = this.getContext();
        const [panelTemplate, dataMaidTemplate, dialogTemplates, componentTemplates] = await Promise.all([
            this.#template('panel'),
            this.#template('data-maid-enhancer'),
            this.#template('dialogs'),
            this.#template('components'),
        ]);

        this.api = new ChatManagerApi(this.getContext);
        this.journal = new TaskJournal();
        this.backups = new BackupService(this.api);
        this.splitter = new SplitService(this.api, this.journal, () => this.getContext().uuidv4());
        const chatActions = createChatActions({
            getContext: this.getContext,
            api: this.api,
            backups: this.backups,
            openRecord: record => this.#openRecord(record),
        });
        const nativePageSize = Number(accountStorage.getItem('Characters_PerPage')) || 50;
        this.dataMaid = new DataMaidEnhancer({ api: this.api, template: dataMaidTemplate });
        const saveViewOptions = (options, source) => {
            const view = this.settings.view;
            view.groupOwners = options.groupOwners;
            view.groupSplits = options.groupSplits;
            if (options.sortOrder) view.sortOrder = options.sortOrder;
            if (options.pageSize) accountStorage.setItem('Characters_PerPage', String(options.pageSize));
            saveSettingsDebounced();
            if (source !== 'manager') this.ui?.setGrouping(options);
            if (source !== 'welcome') this.welcomeRecent?.setGrouping(options);
        };

        this.ui = new ChatManagerUi({
            getContext: this.getContext,
            api: this.api,
            backups: this.backups,
            splitter: this.splitter,
            isGenerating,
            openRecord: record => this.#openRecord(record),
            deleteRecord: chatActions.deleteRecord,
            renameRecord: chatActions.renameRecord,
            refreshRecentChats: () => openWelcomeScreen({ force: true }),
            restoreBackup: chatActions.restoreBackup,
            openDataMaid: () => this.dataMaid.open(),
            template: panelTemplate,
            dialogTemplates,
            componentTemplates,
            getAvatarUrl: record => record.ownerType === 'group'
                ? system_avatar
                : getThumbnailUrl('avatar', record.ownerId),
            viewOptions: {
                groupOwners: this.settings.view.groupOwners,
                groupSplits: this.settings.view.groupSplits,
                sortOrder: this.settings.view.sortOrder,
                pageSize: nativePageSize,
            },
            onViewOptionsChange: options => saveViewOptions(options, 'manager'),
        });
        this.welcomeRecent = new WelcomeRecentEnhancer({
            api: this.api,
            templates: this.ui.getTemplates(),
            getOptions: () => ({
                groupOwners: this.settings.view.groupOwners,
                groupSplits: this.settings.view.groupSplits,
            }),
            onOptionsChange: options => saveViewOptions(options, 'welcome'),
        });
        this.nativePanel = new NativeChatPanel({
            getContext: this.getContext,
            ui: this.ui,
            isGenerating,
        });

        this.#prepareEventBindings(context);
        this.initialized = true;
    }

    /**
     * 获取主面板中的版本入口
     * @returns {object} 版本按钮与文本
     */
    getUpdateView() {
        return this.ui.getExtensionUpdateView();
    }

    /**
     * 根据总开关、模块开关与注入开关计算实际状态
     */
    setEnabled(enabled) {
        if (!this.initialized) return;
        const wasEnabled = this.enabled;
        this.enabled = enabled;
        const integrations = this.settings.integrations;
        this.#setEntryEnabled(enabled);
        if (wasEnabled && !enabled) {
            this.splitter.requestStop();
            this.ui.deactivate();
            void this.backups.dispose();
        }
        this.#setEventsEnabled(enabled);
        this.nativePanel.setEnabled(enabled && integrations.nativeChatPanel !== false);
        this.welcomeRecent.setEnabled(enabled && integrations.welcomeRecent !== false);
        this.dataMaid.setEnabled(enabled && integrations.dataMaid !== false);
        if (enabled) void this.#recoverPendingTasks();
    }

    /**
     * 使用酒馆原生角色与群聊链路打开聊天
     * @param {object} record 聊天记录
     * @returns {Promise<void>}
     */
    async #openRecord(record) {
        return openChatRecord(record, {
            getContext: this.getContext,
            isGenerating,
            openGroupById,
            setActiveCharacter,
            setActiveGroup,
        });
    }

    /**
     * 加载聊天文件模块模板
     * @param {string} name 模板名
     * @returns {Promise<string>} 模板文本
     */
    #template(name) {
        return renderExtensionTemplateAsync(EXTENSION_ID, `templates/chat-files/${name}`);
    }

    /**
     * 根据模块状态挂载或隐藏聊天管理入口
     * @param {boolean} enabled 是否启用
     */
    #setEntryEnabled(enabled) {
        const entry = document.querySelector('#chat_manager_open');
        entry?.classList.toggle('displayNone', !enabled);
        if (!enabled || entry) {
            this.entryController?.abort();
            this.entryController = null;
            return;
        }
        this.entryController?.abort();
        const controller = new AbortController();
        this.entryController = controller;
        void waitForElement('#option_select_chat', { signal: controller.signal }).then(() => {
            if (this.enabled && this.entryController === controller) this.#insertEntry();
        }).catch(error => {
            if (error.name !== 'AbortError') console.error('[酒馆工具箱] 等待聊天文件入口失败', error);
        }).finally(() => {
            if (this.entryController === controller) this.entryController = null;
        });
    }

    /**
     * 将聊天管理入口插入原生聊天文件入口之后
     * @returns {boolean} 是否插入成功
     */
    #insertEntry() {
        const existing = document.querySelector('#chat_manager_open');
        if (existing) {
            existing.classList.toggle('displayNone', !this.enabled);
            return true;
        }
        const anchor = document.querySelector('#option_select_chat');
        if (!anchor) return false;
        const entry = element('a', { attrs: { id: 'chat_manager_open' } });
        entry.append(
            element('i', { className: 'fa-lg fa-solid fa-folder-tree' }),
            element('span', { text: '聊天管理' }),
        );
        entry.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (!this.enabled) return;
            this.ui.open();
            const options = document.querySelector('#options');
            if (options instanceof HTMLElement) options.style.display = 'none';
        });
        entry.classList.toggle('displayNone', !this.enabled);
        anchor.insertAdjacentElement('afterend', entry);
        return true;
    }

    /**
     * 恢复因页面刷新中断的分卷任务
     */
    async #recoverPendingTasks() {
        if (this.recoveryChecked) return;
        this.recoveryChecked = true;
        try {
            const tasks = await this.splitter.reconcile();
            if (!this.enabled) {
                // 停用发生在扫描期间时保留待恢复状态，下次启用重新确认
                if (tasks.length) this.recoveryChecked = false;
                return;
            }
            if (tasks.length) await this.ui.showRecovery(tasks);
        } catch (error) {
            console.error('[酒馆工具箱] 恢复未完成任务失败', error);
        }
    }

    /**
     * 准备生成状态与聊天文件变化事件
     * @param {object} context 酒馆上下文
     */
    #prepareEventBindings(context) {
        const updateState = () => {
            this.ui.updateRuntimeState();
            this.nativePanel.updateRuntimeState();
        };
        for (const eventType of [
            context.eventTypes.GENERATION_STARTED,
            context.eventTypes.GENERATION_ENDED,
            context.eventTypes.GENERATION_STOPPED,
        ].filter(Boolean)) {
            this.eventBindings.push([eventType, updateState]);
        }

        // 原生 recent 接口实时扫描磁盘，事件只安排一次防抖同步
        const chatFileEvents = [
            context.eventTypes.CHAT_CHANGED,
            context.eventTypes.CHAT_CREATED,
            context.eventTypes.CHAT_RENAMED,
            context.eventTypes.CHAT_DELETED,
            context.eventTypes.GROUP_CHAT_CREATED,
            context.eventTypes.GROUP_CHAT_DELETED,
            context.eventTypes.MESSAGE_EDITED,
            context.eventTypes.MESSAGE_DELETED,
            context.eventTypes.MESSAGE_UPDATED,
            context.eventTypes.GENERATION_ENDED,
            context.eventTypes.GENERATION_STOPPED,
        ].filter(Boolean);
        for (const eventType of new Set(chatFileEvents)) {
            this.eventBindings.push([eventType, () => this.ui.invalidateChatFiles()]);
        }
        this.eventSource = context.eventSource;
    }

    /**
     * 启停聊天文件模块的酒馆事件监听
     * @param {boolean} enabled 是否启用监听
     */
    #setEventsEnabled(enabled) {
        if (enabled === this.eventsBound) return;
        this.eventsBound = enabled;
        for (const [eventType, handler] of this.eventBindings) {
            if (enabled) this.eventSource.on(eventType, handler);
            else this.eventSource.removeListener(eventType, handler);
        }
    }
}
