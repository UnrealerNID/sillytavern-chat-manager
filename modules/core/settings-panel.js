import { saveSettingsDebounced } from '/script.js';
import { renderExtensionTemplateAsync } from '/scripts/extensions.js';

const EXTENSION_ID = 'third-party/sillytavern-toolbox';

/**
 * 管理工具箱设置卡片及开关层级
 */
export class ToolboxSettingsPanel {
    /**
     * @param {object} options 配置项
     * @param {object} options.settings 工具箱设置
     * @param {object[]} options.definitions 模块定义
     * @param {import('../platform/extension-updater.js').ExtensionUpdater} options.updater 更新控制器
     * @param {()=>Promise<void>|void} options.onChange 设置变化回调
     */
    constructor({ settings, definitions, updater, onChange }) {
        this.settings = settings;
        this.definitions = definitions;
        this.updater = updater;
        this.onChange = onChange;
        this.moduleRoots = new Map();
    }

    /**
     * 插入酒馆扩展设置栏
     * @returns {Promise<boolean>} 是否插入成功
     */
    async insert() {
        if (document.querySelector('#tavern_toolbox_settings')) return true;
        const container = selectExtensionColumn(this.settings.column);
        if (!container) return false;

        const selectedColumn = container.id === 'extensions_settings' ? 'left' : 'right';
        if (this.settings.column !== selectedColumn) {
            this.settings.column = selectedColumn;
            saveSettingsDebounced();
        }

        const html = await renderExtensionTemplateAsync(EXTENSION_ID, 'templates/settings');
        const holder = document.createElement('template');
        holder.innerHTML = html.trim();
        const root = holder.content.firstElementChild;
        if (!(root instanceof HTMLElement)) throw new Error('工具箱设置模板结构无效');

        this.root = root;
        this.#bindSwitch(root, '[data-toolbox-enabled]', () => this.settings.enabled, value => {
            this.settings.enabled = value;
        });
        await this.#mountModules(root);

        const version = root.querySelector('[data-toolbox-version]');
        const update = root.querySelector('[data-toolbox-update]');
        if (!(version instanceof HTMLElement) || !(update instanceof HTMLButtonElement)) {
            throw new Error('工具箱设置模板缺少版本控件');
        }
        container.append(root);
        this.updater.register(update, version);
        this.#syncHierarchy();
        return true;
    }

    /**
     * 绑定一个设置开关
     * @param {HTMLElement} root 查找控件的根节点
     * @param {string} selector 开关选择器
     * @param {()=>boolean} read 读取设置
     * @param {(value:boolean)=>void} write 写入设置
     */
    #bindSwitch(root, selector, read, write) {
        const input = root.querySelector(selector);
        if (!(input instanceof HTMLInputElement)) throw new Error(`工具箱设置缺少 ${selector}`);
        input.checked = read() !== false;
        input.addEventListener('change', () => {
            write(input.checked);
            saveSettingsDebounced();
            this.#syncHierarchy();
            Promise.resolve(this.onChange()).catch(error => {
                console.error('[酒馆工具箱] 应用扩展设置失败', error);
                globalThis.toastr?.error?.(`应用工具箱设置失败：${error.message}`);
            });
        });
    }

    /**
     * 加载并挂载每个模块自己的设置模板
     * @param {HTMLElement} root 工具箱设置根节点
     */
    async #mountModules(root) {
        const container = root.querySelector('[data-toolbox-modules]');
        if (!(container instanceof HTMLElement)) throw new Error('工具箱设置模板缺少模块挂载点');
        for (const definition of this.definitions) {
            const html = await renderExtensionTemplateAsync(EXTENSION_ID, definition.settingsTemplate);
            const holder = document.createElement('template');
            holder.innerHTML = html.trim();
            const moduleRoot = holder.content.firstElementChild;
            if (!(moduleRoot instanceof HTMLElement)) throw new Error(`${definition.id} 设置模板结构无效`);
            container.append(moduleRoot);
            this.moduleRoots.set(definition.id, moduleRoot);
            definition.bindSettings({
                root: moduleRoot,
                settings: this.settings,
                bindSwitch: this.#bindSwitch.bind(this),
            });
        }
    }

    /**
     * 同步总开关、模块开关与子功能开关的可用关系
     */
    #syncHierarchy() {
        if (!this.root) return;
        const toolboxEnabled = this.settings.enabled !== false;
        for (const definition of this.definitions) {
            definition.syncSettings({
                root: this.moduleRoots.get(definition.id),
                settings: this.settings,
                toolboxEnabled,
            });
        }
    }
}

/**
 * 选择设置卡片插入列
 * @param {'left'|'right'|undefined} savedColumn 已保存位置
 * @returns {HTMLElement|null} 扩展设置列
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
 * 统计扩展设置列中的可见卡片
 * @param {HTMLElement} container 扩展设置列
 * @returns {number} 可见卡片数量
 */
function renderedCardCount(container) {
    return Array.from(container.children).filter(child => {
        if (!(child instanceof HTMLElement)) return false;
        if (child.hidden || getComputedStyle(child).display === 'none') return false;
        return child.childElementCount > 0 || Boolean(child.textContent?.trim());
    }).length;
}
