import {
    getRequestHeaders,
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
    extensionTypes,
    renderExtensionTemplateAsync,
} from '/scripts/extensions.js';
import { isAdmin } from '/scripts/user.js';

import { ChatManagerApi } from './modules/api.js';
import { BackupService } from './modules/backups.js';
import { NativeChatPanel } from './modules/native-chat-panel.js';
import { SplitService } from './modules/splitter.js';
import { TaskJournal } from './modules/task-journal.js';
import { ChatManagerUi } from './modules/ui.js';
import { element, isNewerVersion } from './modules/utils.js';

let initialized = false;
const extensionId = 'third-party/sillytavern-chat-manager';
const extensionFolder = 'sillytavern-chat-manager';
const remoteManifestUrl = 'https://raw.githubusercontent.com/UnrealerNID/sillytavern-chat-manager/main/manifest.json';
const extensionUpdateViews = new Set();
const extensionUpdateState = {
    semanticVersion: '',
    shortHash: '',
    remoteVersion: '',
    phase: 'checking',
    canUpdate: true,
};
let extensionUpdateCheck;

/**
 * 扩展清单中用于界面展示的元数据
 * @typedef {object} ExtensionMetadata
 * @property {string} version 当前扩展版本
 */

/**
 * 插件功能设置
 * @typedef {object} ChatManagerSettings
 * @property {boolean} [enabled] 是否启用插件功能
 * @property {'left'|'right'} [column] 首次选择并固定使用的扩展栏
 */

/**
 * 酒馆原生扩展版本接口返回值
 * @typedef {object} ExtensionVersionStatus
 * @property {string} [currentCommitHash] 当前 Git 提交号
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
        return { version: '未知' };
    }
}

/**
 * 判断当前插件是否安装在酒馆全局扩展目录
 * @returns {boolean} 是否为全局扩展
 */
function isGlobalExtension() {
    return extensionTypes[extensionId] === 'global';
}

/**
 * 使用酒馆原生版本接口读取 Git 状态
 * @returns {Promise<ExtensionVersionStatus>} 当前版本状态
 */
async function getExtensionVersionStatus() {
    const response = await fetch('/api/extensions/version', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ extensionName: extensionFolder, global: isGlobalExtension() }),
    });
    if (!response.ok) throw new Error(await response.text() || response.statusText);
    return response.json();
}

/**
 * 读取远端发布清单中的语义版本
 * @returns {Promise<string>} 远端语义版本
 */
async function getRemoteExtensionVersion() {
    const response = await fetch(remoteManifestUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const metadata = await response.json();
    if (typeof metadata.version !== 'string') throw new Error('远端扩展清单缺少版本号');
    return metadata.version;
}

/**
 * 使用酒馆原生更新接口拉取插件远程提交
 * @returns {Promise<{isUpToDate:boolean, shortCommitHash?:string}>} 更新结果
 */
async function updateExtension() {
    const response = await fetch('/api/extensions/update', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ extensionName: extensionFolder, global: isGlobalExtension() }),
    });
    if (!response.ok) throw new Error(await response.text() || response.statusText);
    return response.json();
}

/**
 * 同步所有版本与更新视图
 * @returns {void}
 */
function renderExtensionUpdateViews() {
    const versionText = `version ${extensionUpdateState.semanticVersion}${extensionUpdateState.shortHash ? ` (${extensionUpdateState.shortHash})` : ''}`;
    const labels = {
        checking: '检查更新…',
        current: '已是最新',
        available: extensionUpdateState.canUpdate ? '更新' : '有可用更新',
        updating: '更新中…',
        updated: '更新完成',
        retry: '重试更新',
        failed: '检查失败',
    };
    for (const view of extensionUpdateViews) {
        view.version.textContent = versionText;
        view.button.textContent = labels[extensionUpdateState.phase];
        view.button.disabled = (extensionUpdateState.phase !== 'available' && extensionUpdateState.phase !== 'retry')
            || (extensionUpdateState.phase === 'available' && !extensionUpdateState.canUpdate);
        view.button.title = extensionUpdateState.phase === 'available' && extensionUpdateState.remoteVersion
            ? `更新至 version ${extensionUpdateState.remoteVersion}`
            : '';
    }
}

/**
 * 检查本地提交号与远端发布版本
 * @returns {Promise<void>}
 */
async function checkExtensionUpdate() {
    extensionUpdateState.phase = 'checking';
    renderExtensionUpdateViews();
    const [installation, remote] = await Promise.allSettled([
        getExtensionVersionStatus(),
        getRemoteExtensionVersion(),
    ]);
    if (installation.status === 'fulfilled') {
        extensionUpdateState.shortHash = installation.value.currentCommitHash?.slice(0, 7) ?? '';
    } else {
        console.warn('[聊天文件管理] 读取扩展提交号失败', installation.reason);
    }
    if (remote.status === 'rejected') {
        console.warn('[聊天文件管理] 检查扩展更新失败', remote.reason);
        extensionUpdateState.phase = 'failed';
        renderExtensionUpdateViews();
        return;
    }
    extensionUpdateState.remoteVersion = remote.value;
    extensionUpdateState.canUpdate = !isGlobalExtension() || isAdmin();
    extensionUpdateState.phase = isNewerVersion(remote.value, extensionUpdateState.semanticVersion) ? 'available' : 'current';
    renderExtensionUpdateViews();
}

/**
 * 通过酒馆原生接口执行更新并同步所有入口
 * @returns {Promise<void>}
 */
async function performExtensionUpdate() {
    if (!['available', 'retry'].includes(extensionUpdateState.phase)) return;
    extensionUpdateState.phase = 'updating';
    renderExtensionUpdateViews();
    try {
        const result = await updateExtension();
        if (result.isUpToDate) {
            extensionUpdateState.phase = 'retry';
            renderExtensionUpdateViews();
            globalThis.toastr?.warning?.('酒馆未拉取到新提交，请稍后重试');
            return;
        }
        extensionUpdateState.phase = 'updated';
        renderExtensionUpdateViews();
        globalThis.toastr?.success?.('插件更新完成，正在刷新页面');
        setTimeout(() => location.reload(), 500);
    } catch (error) {
        console.error('[聊天文件管理] 更新扩展失败', error);
        extensionUpdateState.phase = 'retry';
        renderExtensionUpdateViews();
        globalThis.toastr?.error?.(`插件更新失败：${error.message}`);
    }
}

/**
 * 注册一个版本与更新视图
 * @param {HTMLButtonElement} button 更新按钮
 * @param {HTMLElement} version 版本文本
 * @param {string} semanticVersion 清单语义版本
 * @returns {void}
 */
function configureUpdateButton(button, version, semanticVersion) {
    extensionUpdateState.semanticVersion = semanticVersion;
    extensionUpdateViews.add({ button, version });
    button.addEventListener('click', () => void performExtensionUpdate());
    renderExtensionUpdateViews();
    extensionUpdateCheck ??= checkExtensionUpdate();
}

/**
 * 将复选框绑定到插件自身的功能状态
 * @param {HTMLInputElement} toggle 启用复选框
 * @param {ChatManagerSettings} settings 插件设置
 * @param {(enabled:boolean)=>void} applyEnabledState 应用状态
 */
function configureEnabledToggle(toggle, settings, applyEnabledState) {
    toggle.checked = settings.enabled !== false;
    toggle.addEventListener('change', () => {
        settings.enabled = toggle.checked;
        saveSettingsDebounced();
        applyEnabledState(toggle.checked);
        globalThis.toastr?.success?.(`聊天文件管理已${toggle.checked ? '启用' : '停用'}`);
    });
}

/**
 * 统计扩展栏中已经填充且未隐藏的顶层扩展卡
 * @param {HTMLElement} container 扩展栏容器
 * @returns {number} 已渲染的扩展卡数量
 */
function countRenderedExtensionCards(container) {
    return Array.from(container.children).filter(child => {
        if (!(child instanceof HTMLElement)) return false;
        if (child.hidden || getComputedStyle(child).display === 'none') return false;
        return child.childElementCount > 0 || Boolean(child.textContent?.trim());
    }).length;
}

/**
 * 优先选择已保存的扩展栏，否则选择当前扩展卡数量较少的栏
 * @param {'left'|'right'|undefined} savedColumn 已保存的扩展栏
 * @returns {HTMLElement|null} 目标扩展栏；两栏数量相同时返回左栏
 */
function selectExtensionColumn(savedColumn) {
    const left = document.querySelector('#extensions_settings');
    const right = document.querySelector('#extensions_settings2');
    if (savedColumn === 'left' && left instanceof HTMLElement) return left;
    if (savedColumn === 'right' && right instanceof HTMLElement) return right;
    if (!(left instanceof HTMLElement)) return right instanceof HTMLElement ? right : null;
    if (!(right instanceof HTMLElement)) return left;
    return countRenderedExtensionCards(left) <= countRenderedExtensionCards(right) ? left : right;
}

/**
 * 向酒馆原生扩展程序抽屉添加状态卡片
 * @param {ExtensionMetadata} metadata 扩展元数据
 * @param {ChatManagerSettings} settings 插件功能设置
 * @param {(enabled:boolean)=>void} applyEnabledState 应用状态
 * @returns {Promise<boolean>} 是否已找到原生容器并完成插入
 */
async function insertExtensionStatus(metadata, settings, applyEnabledState) {
    if (document.querySelector('#chat_manager_extension_status')) return true;
    const container = selectExtensionColumn(settings.column);
    if (!container) return false;
    const selectedColumn = container.id === 'extensions_settings' ? 'left' : 'right';
    if (settings.column !== selectedColumn) {
        settings.column = selectedColumn;
        saveSettingsDebounced();
    }

    const html = await renderExtensionTemplateAsync('third-party/sillytavern-chat-manager', 'settings');
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    const drawer = template.content.firstElementChild;
    const version = drawer?.querySelector('.chat-manager-extension-version');
    const enabledToggle = drawer?.querySelector('#chat_manager_enabled');
    const updateButton = drawer?.querySelector('#chat_manager_update');
    if (!(drawer instanceof HTMLElement)
        || !(version instanceof HTMLElement)
        || !(enabledToggle instanceof HTMLInputElement)
        || !(updateButton instanceof HTMLButtonElement)) {
        throw new Error('扩展设置模板结构无效');
    }

    version.textContent = `version ${metadata.version}`;
    configureEnabledToggle(enabledToggle, settings, applyEnabledState);
    container.append(drawer);
    configureUpdateButton(updateButton, version, metadata.version);
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
    const [metadata, panelTemplate] = await Promise.all([
        loadExtensionMetadata(),
        renderExtensionTemplateAsync('third-party/sillytavern-chat-manager', 'panel'),
    ]);
    const ui = new ChatManagerUi({
        getContext,
        api,
        backups,
        splitter,
        isGenerating,
        openRecord,
        template: panelTemplate,
        getAvatarUrl: record => record.ownerType === 'group' ? system_avatar : getThumbnailUrl('avatar', record.ownerId),
    });
    const nativePanel = new NativeChatPanel({ getContext, ui, isGenerating });
    const panelUpdateView = ui.getExtensionUpdateView();
    configureUpdateButton(panelUpdateView.button, panelUpdateView.version, metadata.version);
    const settings = extension_settings.chatManager ??= {};
    settings.enabled ??= true;
    let recoveryChecked = false;

    const recoverPendingTasks = async () => {
        if (recoveryChecked) return;
        recoveryChecked = true;
        try {
            const tasks = await splitter.reconcile();
            if (settings.enabled && tasks.length) await ui.showRecovery(tasks);
        } catch (error) {
            console.error('[聊天文件管理] 恢复未完成任务失败', error);
        }
    };

    const applyEnabledState = (enabled) => {
        document.querySelector('#chat_manager_open')?.classList.toggle('displayNone', !enabled);
        if (!enabled) ui.close();
        nativePanel.setEnabled(enabled);
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
        if (!await insertExtensionStatus(metadata, settings, applyEnabledState)) {
            setTimeout(() => {
                insertExtensionStatus(metadata, settings, applyEnabledState).catch(error => {
                    console.error('[聊天文件管理] 插入扩展设置失败', error);
                });
            }, 1000);
        }
    } catch (error) {
        console.error('[聊天文件管理] 插入扩展设置失败', error);
    }
    applyEnabledState(settings.enabled);
    if (!nativePanel.init()) setTimeout(() => nativePanel.init(), 1000);

    const updateState = () => {
        ui.updateRuntimeState();
        nativePanel.updateRuntimeState();
    };
    context.eventSource.on(context.eventTypes.GENERATION_STARTED, updateState);
    context.eventSource.on(context.eventTypes.GENERATION_ENDED, updateState);
    context.eventSource.on(context.eventTypes.GENERATION_STOPPED, updateState);

}
