import {
    getRequestHeaders,
} from '/script.js';
import {
    extensionTypes,
} from '/scripts/extensions.js';
import { isAdmin } from '/scripts/user.js';

import { isNewerVersion } from './version.js';
import {
    EXTENSION_FOLDER,
    EXTENSION_ID,
    REMOTE_MANIFEST_URL,
} from './extension-identity.js';

/**
 * 读取插件自身清单
 * @returns {Promise<{version:string}>} 插件元数据
 */
export async function loadExtensionMetadata() {
    try {
        const response = await fetch(new URL('../../manifest.json', import.meta.url), {
            cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        console.warn('[酒馆工具箱] 读取扩展元数据失败', error);
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
        button.addEventListener('click', () => void this.#activate());
        this.#render();
        if (this.state.phase === 'checking') void this.#requestCheck();
    }

    /**
     * 合并并发更新检查，并允许失败后重新执行
     */
    #requestCheck() {
        this.checkTask ??= this.#check().finally(() => {
            this.checkTask = null;
        });
        return this.checkTask;
    }

    /**
     * 根据当前状态执行检查或更新
     */
    #activate() {
        if (this.state.phase === 'check-failed') return this.#requestCheck();
        return this.#update();
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
            'check-failed': '重试检查',
        };
        for (const view of this.views) {
            view.version.textContent = `version ${state.semanticVersion}${hash}`;
            view.button.textContent = labels[state.phase];
            view.button.disabled = !['available', 'retry', 'check-failed'].includes(state.phase)
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
            console.warn('[酒馆工具箱] 读取扩展提交号失败', installation.reason);
        }
        if (remote.status === 'rejected') {
            console.warn('[酒馆工具箱] 检查扩展更新失败', remote.reason);
            this.state.phase = 'check-failed';
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
            console.error('[酒馆工具箱] 更新扩展失败', error);
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
