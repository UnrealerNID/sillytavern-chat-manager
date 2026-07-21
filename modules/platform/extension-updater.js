import {
    getRequestHeaders,
    saveSettingsDebounced,
} from '/script.js';
import {
    extensionTypes,
    renderExtensionTemplateAsync,
} from '/scripts/extensions.js';
import { isAdmin } from '/scripts/user.js';

import { isNewerVersion } from '../shared/utils.js';

const EXTENSION_ID = 'third-party/sillytavern-chat-manager';
const EXTENSION_FOLDER = 'sillytavern-chat-manager';
const REMOTE_MANIFEST_URL = 'https://raw.githubusercontent.com/UnrealerNID/sillytavern-chat-manager/main/manifest.json';

/**
 * 读取插件自身清单
 * @returns {Promise<{version:string}>} 插件元数据
 */
export async function loadExtensionMetadata() {
    try {
        const response = await fetch(new URL('../manifest.json', import.meta.url), {
            cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        console.warn('[聊天文件管理] 读取扩展元数据失败', error);
        return { version: '未知' };
    }
}

/**
 * 统一管理设置页与主面板中的版本状态
 */
export class ExtensionUpdater {
    /**
     * @param {string} semanticVersion 当前语义版本
     */
    constructor(semanticVersion) {
        this.views = new Set();
        this.checkTask = null;
        this.state = {
            semanticVersion,
            shortHash: '',
            remoteVersion: '',
            phase: 'checking',
            canUpdate: true,
        };
    }

    /**
     * 注册一个版本显示入口
     * @param {HTMLButtonElement} button 更新按钮
     * @param {HTMLElement} version 版本文本
     */
    register(button, version) {
        this.views.add({ button, version });
        button.addEventListener('click', () => void this.#update());
        this.#render();
        this.checkTask ??= this.#check();
    }

    /**
     * 插入酒馆原生扩展设置卡片
     * @param {object} settings 插件设置
     * @param {(enabled:boolean)=>void} applyEnabledState 应用启停状态
     * @returns {Promise<boolean>} 是否成功插入
     */
    async insertSettings(settings, applyEnabledState) {
        if (document.querySelector('#chat_manager_extension_status')) return true;
        const container = selectExtensionColumn(settings.column);
        if (!container) return false;

        const selectedColumn = container.id === 'extensions_settings' ? 'left' : 'right';
        if (settings.column !== selectedColumn) {
            settings.column = selectedColumn;
            saveSettingsDebounced();
        }

        const html = await renderExtensionTemplateAsync(EXTENSION_ID, 'templates/settings');
        const template = document.createElement('template');
        template.innerHTML = html.trim();
        const drawer = template.content.firstElementChild;
        const version = drawer?.querySelector('.chat-manager-extension-version');
        const toggle = drawer?.querySelector('#chat_manager_enabled');
        const update = drawer?.querySelector('#chat_manager_update');
        if (!(drawer instanceof HTMLElement)
            || !(version instanceof HTMLElement)
            || !(toggle instanceof HTMLInputElement)
            || !(update instanceof HTMLButtonElement)) {
            throw new Error('扩展设置模板结构无效');
        }

        bindEnabledToggle(toggle, settings, applyEnabledState);
        container.append(drawer);
        this.register(update, version);
        return true;
    }

    /**
     * 同步所有版本入口
     */
    #render() {
        const state = this.state;
        const hash = state.shortHash ? ` (${state.shortHash})` : '';
        const labels = {
            checking: '检查更新…',
            current: '已是最新',
            available: state.canUpdate ? '更新' : '有可用更新',
            updating: '更新中…',
            updated: '更新完成',
            retry: '重试更新',
            failed: '检查失败',
        };
        for (const view of this.views) {
            view.version.textContent = `version ${state.semanticVersion}${hash}`;
            view.button.textContent = labels[state.phase];
            view.button.disabled = (state.phase !== 'available' && state.phase !== 'retry')
                || (state.phase === 'available' && !state.canUpdate);
            view.button.title = state.phase === 'available' && state.remoteVersion
                ? `更新至 version ${state.remoteVersion}`
                : '';
        }
    }

    /**
     * 检查本地提交号与远端版本
     */
    async #check() {
        this.state.phase = 'checking';
        this.#render();
        const [installation, remote] = await Promise.allSettled([
            getExtensionVersionStatus(),
            getRemoteExtensionVersion(),
        ]);
        if (installation.status === 'fulfilled') {
            this.state.shortHash = installation.value.currentCommitHash?.slice(0, 7) ?? '';
        } else {
            console.warn('[聊天文件管理] 读取扩展提交号失败', installation.reason);
        }
        if (remote.status === 'rejected') {
            console.warn('[聊天文件管理] 检查扩展更新失败', remote.reason);
            this.state.phase = 'failed';
            this.#render();
            return;
        }
        this.state.remoteVersion = remote.value;
        this.state.canUpdate = !isGlobalExtension() || isAdmin();
        this.state.phase = isNewerVersion(remote.value, this.state.semanticVersion)
            ? 'available'
            : 'current';
        this.#render();
    }

    /**
     * 使用酒馆原生接口更新插件
     */
    async #update() {
        if (!['available', 'retry'].includes(this.state.phase)) return;
        this.state.phase = 'updating';
        this.#render();
        try {
            const result = await requestExtensionUpdate();
            if (result.isUpToDate) {
                this.state.phase = 'retry';
                this.#render();
                globalThis.toastr?.warning?.('酒馆未拉取到新提交，请稍后重试');
                return;
            }
            this.state.phase = 'updated';
            this.#render();
            globalThis.toastr?.success?.('插件更新完成，正在刷新页面');
            setTimeout(() => location.reload(), 500);
        } catch (error) {
            console.error('[聊天文件管理] 更新扩展失败', error);
            this.state.phase = 'retry';
            this.#render();
            globalThis.toastr?.error?.(`插件更新失败：${error.message}`);
        }
    }
}

/**
 * 判断插件是否安装在全局扩展目录
 * @returns {boolean} 是否为全局扩展
 */
function isGlobalExtension() {
    return extensionTypes[EXTENSION_ID] === 'global';
}

/**
 * 读取酒馆记录的插件提交号
 * @returns {Promise<{currentCommitHash?:string}>} 版本状态
 */
async function getExtensionVersionStatus() {
    return postExtensionRequest('/api/extensions/version');
}

/**
 * 请求酒馆更新插件
 * @returns {Promise<{isUpToDate:boolean,shortCommitHash?:string}>} 更新结果
 */
async function requestExtensionUpdate() {
    return postExtensionRequest('/api/extensions/update');
}

/**
 * 调用酒馆原生扩展接口
 * @param {string} path 接口路径
 * @returns {Promise<any>} 接口结果
 */
async function postExtensionRequest(path) {
    const response = await fetch(path, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            extensionName: EXTENSION_FOLDER,
            global: isGlobalExtension(),
        }),
    });
    if (!response.ok) throw new Error(await response.text() || response.statusText);
    return response.json();
}

/**
 * 读取远端清单版本
 * @returns {Promise<string>} 远端版本号
 */
async function getRemoteExtensionVersion() {
    const response = await fetch(REMOTE_MANIFEST_URL, {
        cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const metadata = await response.json();
    if (typeof metadata.version !== 'string') throw new Error('远端扩展清单缺少版本号');
    return metadata.version;
}

/**
 * 绑定插件启用开关
 * @param {HTMLInputElement} toggle 启用开关
 * @param {object} settings 插件设置
 * @param {(enabled:boolean)=>void} applyEnabledState 应用状态
 */
function bindEnabledToggle(toggle, settings, applyEnabledState) {
    toggle.checked = settings.enabled !== false;
    toggle.addEventListener('change', () => {
        settings.enabled = toggle.checked;
        saveSettingsDebounced();
        applyEnabledState(toggle.checked);
        globalThis.toastr?.success?.(`聊天文件管理已${toggle.checked ? '启用' : '停用'}`);
    });
}

/**
 * 选择要插入插件设置卡片的扩展栏
 * @param {'left'|'right'|undefined} savedColumn 已保存位置
 * @returns {HTMLElement|null} 扩展栏
 */
function selectExtensionColumn(savedColumn) {
    const left = document.querySelector('#extensions_settings');
    const right = document.querySelector('#extensions_settings2');
    if (savedColumn === 'left' && left instanceof HTMLElement) return left;
    if (savedColumn === 'right' && right instanceof HTMLElement) return right;
    if (!(left instanceof HTMLElement)) return right instanceof HTMLElement ? right : null;
    if (!(right instanceof HTMLElement)) return left;
    return renderedCardCount(left) <= renderedCardCount(right) ? left : right;
}

/**
 * 统计扩展栏中的可见卡片
 * @param {HTMLElement} container 扩展栏
 * @returns {number} 可见卡片数量
 */
function renderedCardCount(container) {
    return Array.from(container.children).filter(child => {
        if (!(child instanceof HTMLElement)) return false;
        if (child.hidden || getComputedStyle(child).display === 'none') return false;
        return child.childElementCount > 0 || Boolean(child.textContent?.trim());
    }).length;
}
