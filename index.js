import { isGenerating, saveSettingsDebounced, setActiveCharacter, setActiveGroup } from '/script.js';
import { openGroupById } from '/scripts/group-chats.js';
import { extension_settings } from '/scripts/extensions.js';

import { ChatManagerApi } from './modules/api.js';
import { BackupService } from './modules/backups.js';
import { NativeChatPanel } from './modules/native-chat-panel.js';
import { SplitService } from './modules/splitter.js';
import { TaskJournal } from './modules/task-journal.js';
import { ChatManagerUi } from './modules/ui.js';
import { element } from './modules/utils.js';

let initialized = false;

/**
 * 扩展清单中用于界面展示的元数据
 * @typedef {object} ExtensionMetadata
 * @property {string} display_name 扩展显示名称
 * @property {string} version 当前扩展版本
 */

/**
 * 插件功能设置
 * @typedef {object} ChatManagerSettings
 * @property {boolean} enabled 是否启用插件功能
 */

/**
 * 读取已安装的扩展清单，确保界面展示信息只有一个数据来源
 * @returns {Promise<ExtensionMetadata>} 扩展元数据
 */
async function loadExtensionMetadata() {
    try {
        const response = await fetch(new URL('./manifest.json', import.meta.url), { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        console.warn('[聊天文件管理] 读取扩展元数据失败', error);
        return { display_name: '聊天文件管理', version: '未知' };
    }
}

/**
 * 向酒馆原生扩展程序抽屉添加状态卡片
 * @param {ExtensionMetadata} metadata 扩展元数据
 * @param {ChatManagerSettings} settings 插件功能设置
 * @param {(enabled: boolean) => void} onEnabledChange 启用状态变更回调
 * @returns {boolean} 是否已找到原生容器并完成插入
 */
function insertExtensionStatus(metadata, settings, onEnabledChange) {
    if (document.querySelector('#chat_manager_extension_status')) return true;
    const container = document.querySelector('#extensions_settings2');
    if (!container) return false;

    const drawer = element('div', {
        className: 'inline-drawer chat-manager-extension-status',
        attrs: { id: 'chat_manager_extension_status' },
    });
    const header = element('div', { className: 'inline-drawer-toggle inline-drawer-header' });
    const title = element('b', { text: metadata.display_name || '聊天文件管理' });
    const icon = element('div', { className: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' });
    header.append(title, icon);

    const content = element('div', { className: 'inline-drawer-content' });
    const versionRow = element('div', { className: 'chat-manager-setting-row' });
    versionRow.append(
        element('span', { text: '版本' }),
        element('span', { className: 'chat-manager-extension-version', text: `v${metadata.version}` }),
    );
    const enabledLabel = element('label', { className: 'chat-manager-setting-row checkbox_label' });
    const enabledToggle = element('input', {
        className: 'checkbox',
        attrs: { id: 'chat_manager_enabled', type: 'checkbox' },
    });
    enabledToggle.checked = settings.enabled;
    enabledToggle.addEventListener('change', () => onEnabledChange(enabledToggle.checked));
    enabledLabel.append(element('span', { text: '启用扩展' }), enabledToggle);
    content.append(versionRow, enabledLabel);
    drawer.append(header, content);
    container.append(drawer);
    return true;
}

function getContext() {
    return SillyTavern.getContext();
}

/**
 * 打开指定聊天记录
 * @param {import('./modules/utils.js').ChatRecord} record 待打开的聊天记录
 * @returns {Promise<void>}
 */
async function openRecord(record) {
    if (isGenerating()) throw new Error('聊天正在生成，当前不能切换聊天');
    let context = getContext();
    if (record.ownerType === 'character') {
        const characterId = context.characters.findIndex(character => character.avatar === record.ownerId);
        if (characterId < 0) throw new Error('目标角色已不存在');
        await context.selectCharacterById(characterId);
        setActiveCharacter(record.ownerId);
        context.saveSettingsDebounced();
        context = getContext();
        if (context.getCurrentChatId() !== record.fileId) await context.openCharacterChat(record.fileId);
        return;
    }

    const group = context.groups.find(item => String(item.id) === String(record.ownerId));
    if (!group) throw new Error('目标群组已不存在');
    if (!group.chats?.includes(record.fileId)) throw new Error('目标聊天已不在群组登记中');
    await openGroupById(record.ownerId);
    setActiveGroup(record.ownerId);
    context.saveSettingsDebounced();
    context = getContext();
    if (context.getCurrentChatId() !== record.fileId) await context.openGroupChat(record.ownerId, record.fileId);
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
    const ui = new ChatManagerUi({ getContext, api, backups, splitter, isGenerating, openRecord });
    const nativePanel = new NativeChatPanel({ getContext, ui, isGenerating });
    const metadata = await loadExtensionMetadata();
    const settings = extension_settings.chatManager ??= { enabled: true };
    if (typeof settings.enabled !== 'boolean') settings.enabled = true;

    const applyEnabledState = enabled => {
        settings.enabled = enabled;
        document.querySelector('#chat_manager_open')?.toggleAttribute('hidden', !enabled);
        nativePanel.setEnabled(enabled);
    };

    const onEnabledChange = enabled => {
        applyEnabledState(enabled);
        saveSettingsDebounced();
    };

    const insertEntry = () => {
        if (document.querySelector('#chat_manager_open')) return true;
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
        entry.toggleAttribute('hidden', !settings.enabled);
        anchor.insertAdjacentElement('afterend', entry);
        return true;
    };

    if (!insertEntry()) setTimeout(() => {
        if (!insertEntry()) globalThis.toastr?.error?.('聊天管理无法找到原生聊天文件入口');
    }, 1000);
    if (!insertExtensionStatus(metadata, settings, onEnabledChange)) {
        setTimeout(() => insertExtensionStatus(metadata, settings, onEnabledChange), 1000);
    }
    if (!nativePanel.init()) setTimeout(() => nativePanel.init(), 1000);
    applyEnabledState(settings.enabled);

    const updateState = () => {
        ui.updateRuntimeState();
        nativePanel.updateRuntimeState();
    };
    context.eventSource.on(context.eventTypes.GENERATION_STARTED, updateState);
    context.eventSource.on(context.eventTypes.GENERATION_ENDED, updateState);
    context.eventSource.on(context.eventTypes.GENERATION_STOPPED, updateState);

    try {
        const tasks = await splitter.reconcile();
        if (tasks.length) await ui.showRecovery(tasks);
    } catch (error) {
        console.error('[聊天文件管理] 恢复未完成任务失败', error);
    }
}
