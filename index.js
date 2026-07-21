import {
    getThumbnailUrl,
    isGenerating,
    saveSettingsDebounced,
    setActiveCharacter,
    setActiveGroup,
    system_avatar,
} from '/script.js';
import { openGroupById } from '/scripts/group-chats.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '/scripts/extensions.js';
import { accountStorage } from '/scripts/util/AccountStorage.js';
import { openWelcomeScreen } from '/scripts/welcome-screen.js';

import { BackupService } from './modules/backups/backups.js';
import { DataMaidEnhancer } from './modules/backups/data-maid-enhancer.js';
import { createChatActions } from './modules/chat/chat-actions.js';
import { openChatRecord } from './modules/chat/chat-opener.js';
import { SplitService } from './modules/chat/splitter.js';
import { TaskJournal } from './modules/chat/task-journal.js';
import { ChatManagerApi } from './modules/platform/api.js';
import {
    ExtensionUpdater,
    loadExtensionMetadata,
} from './modules/platform/extension-updater.js';
import { element } from './modules/shared/utils.js';
import { ChatManagerUi } from './modules/ui/ui.js';
import { NativeChatPanel } from './modules/ui/native-chat-panel.js';
import { WelcomeRecentEnhancer } from './modules/ui/welcome-recent.js';

let initialized = false;

function getContext() {
    return SillyTavern.getContext();
}

/**
 * 打开指定聊天记录
 * @param {object} record 待打开的聊天记录
 * @returns {Promise<void>}
 */
async function openRecord(record) {
    return openChatRecord(record, {
        getContext,
        isGenerating,
        openGroupById,
        setActiveCharacter,
        setActiveGroup,
    });
}

/**
 * 通过酒馆扩展清单钩子激活插件
 * @returns {Promise<void>}
 */
export async function init() {
    if (initialized) return;
    initialized = true;
    const context = getContext();
    const api = new ChatManagerApi(getContext);
    const journal = new TaskJournal();
    const backups = new BackupService(api);
    const splitter = new SplitService(api, journal, () => getContext().uuidv4());
    const chatActions = createChatActions({
        getContext,
        api,
        backups,
        openRecord,
    });
    const settings = extension_settings.chatManager ??= {};
    settings.enabled ??= true;
    settings.groupOwners ??= false;
    settings.groupSplits ??= false;
    settings.sortOrder ??= 'newest';
    if (Object.hasOwn(settings, 'pageSize')) {
        delete settings.pageSize;
        saveSettingsDebounced();
    }
    const nativePageSize = Number(accountStorage.getItem('Characters_PerPage')) || 50;
    const [metadata, panelTemplate, dataMaidTemplate, dialogTemplates, componentTemplates] = await Promise.all([
        loadExtensionMetadata(),
        renderExtensionTemplateAsync('third-party/sillytavern-toolbox', 'templates/panel'),
        renderExtensionTemplateAsync('third-party/sillytavern-toolbox', 'templates/data-maid-enhancer'),
        renderExtensionTemplateAsync('third-party/sillytavern-toolbox', 'templates/dialogs'),
        renderExtensionTemplateAsync('third-party/sillytavern-toolbox', 'templates/components'),
    ]);
    const updater = new ExtensionUpdater(metadata.version);
    const dataMaid = new DataMaidEnhancer({ api, template: dataMaidTemplate });
    let ui;
    let welcomeRecent;
    const saveViewOptions = (options, source) => {
        settings.groupOwners = options.groupOwners;
        settings.groupSplits = options.groupSplits;
        if (options.sortOrder) settings.sortOrder = options.sortOrder;
        if (options.pageSize) accountStorage.setItem('Characters_PerPage', String(options.pageSize));
        saveSettingsDebounced();
        if (source !== 'manager') ui?.setGrouping(options);
        if (source !== 'welcome') welcomeRecent?.setGrouping(options);
    };
    ui = new ChatManagerUi({
        getContext,
        api,
        backups,
        splitter,
        isGenerating,
        openRecord,
        deleteRecord: chatActions.deleteRecord,
        renameRecord: chatActions.renameRecord,
        refreshRecentChats: () => openWelcomeScreen({ force: true }),
        restoreBackup: chatActions.restoreBackup,
        openDataMaid: () => dataMaid.open(),
        template: panelTemplate,
        dialogTemplates,
        componentTemplates,
        getAvatarUrl: record => record.ownerType === 'group'
            ? system_avatar
            : getThumbnailUrl('avatar', record.ownerId),
        viewOptions: {
            groupOwners: settings.groupOwners,
            groupSplits: settings.groupSplits,
            sortOrder: settings.sortOrder,
            pageSize: nativePageSize,
        },
        onViewOptionsChange: options => saveViewOptions(options, 'manager'),
    });
    welcomeRecent = new WelcomeRecentEnhancer({
        api,
        templates: ui.getTemplates(),
        getOptions: () => ({
            groupOwners: settings.groupOwners,
            groupSplits: settings.groupSplits,
        }),
        onOptionsChange: options => saveViewOptions(options, 'welcome'),
    });
    const nativePanel = new NativeChatPanel({ getContext, ui, isGenerating });
    const panelUpdateView = ui.getExtensionUpdateView();
    updater.register(panelUpdateView.button, panelUpdateView.version);
    let recoveryChecked = false;

    const recoverPendingTasks = async () => {
        if (recoveryChecked) return;
        recoveryChecked = true;
        try {
            const tasks = await splitter.reconcile();
            if (settings.enabled && tasks.length) await ui.showRecovery(tasks);
        } catch (error) {
            console.error('[酒馆工具箱] 恢复未完成任务失败', error);
        }
    };

    const applyEnabledState = (enabled) => {
        document.querySelector('#chat_manager_open')?.classList.toggle('displayNone', !enabled);
        if (!enabled) {
            ui.close();
            void backups.dispose();
        }
        dataMaid.setEnabled(enabled);
        nativePanel.setEnabled(enabled);
        welcomeRecent.setEnabled(enabled);
        if (enabled) void recoverPendingTasks();
    };

    const insertEntry = () => {
        const existing = document.querySelector('#chat_manager_open');
        if (existing) {
            existing.classList.toggle('displayNone', !settings.enabled);
            return true;
        }
        const anchor = document.querySelector('#option_select_chat');
        if (!anchor) return false;
        const entry = element('a', { attrs: { id: 'chat_manager_open' } });
        const icon = element('i', { className: 'fa-lg fa-solid fa-folder-tree' });
        entry.append(icon, element('span', { text: '聊天管理' }));
        entry.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            ui.open();
            const options = document.querySelector('#options');
            if (options instanceof HTMLElement) options.style.display = 'none';
        });
        entry.classList.toggle('displayNone', !settings.enabled);
        anchor.insertAdjacentElement('afterend', entry);
        return true;
    };

    if (!insertEntry()) setTimeout(() => {
        if (!insertEntry()) globalThis.toastr?.error?.('聊天管理无法找到原生聊天文件入口');
    }, 1000);
    try {
        if (!await updater.insertSettings(settings, applyEnabledState)) {
            setTimeout(() => {
                updater.insertSettings(settings, applyEnabledState).catch(error => {
                    console.error('[酒馆工具箱] 插入扩展设置失败', error);
                });
            }, 1000);
        }
    } catch (error) {
        console.error('[酒馆工具箱] 插入扩展设置失败', error);
    }
    applyEnabledState(settings.enabled);
    if (!nativePanel.init()) setTimeout(() => nativePanel.init(), 1000);
    if (!welcomeRecent.init()) setTimeout(() => welcomeRecent.init(), 1000);

    const updateState = () => {
        ui.updateRuntimeState();
        nativePanel.updateRuntimeState();
    };
    context.eventSource.on(context.eventTypes.GENERATION_STARTED, updateState);
    context.eventSource.on(context.eventTypes.GENERATION_ENDED, updateState);
    context.eventSource.on(context.eventTypes.GENERATION_STOPPED, updateState);

    // 原生 recent 接口会实时扫描磁盘；事件只负责在文件可能变化时安排一次防抖同步
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
        context.eventSource.on(eventType, () => ui.invalidateChatFiles());
    }

}
