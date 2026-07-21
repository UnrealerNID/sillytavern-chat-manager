import { element } from '../shared/utils.js';

export class NativeChatPanel {
    /**
     * @param {object} options 配置项
     * @param {()=>any} options.getContext 上下文提供器
     * @param {import('./ui.js').ChatManagerUi} options.ui 界面控制器
     * @param {()=>boolean} options.isGenerating 是否正在生成
     */
    constructor({ getContext, ui, isGenerating }) {
        this.getContext = getContext;
        this.ui = ui;
        this.isGenerating = isGenerating;
        this.enabled = true;
    }

    /**
     * 挂载原生聊天文件面板增强
     * @returns {boolean} 是否找到并完成挂载
     */
    init() {
        this.container = document.querySelector('#select_chat_div');
        if (!this.container) return false;
        this.container.addEventListener('click', event => this.#onClick(event));
        this.observer = new MutationObserver(() => this.enhance());
        this.observer.observe(this.container, { childList: true, subtree: true });
        this.enhance();
        return true;
    }

    /**
     * 即时切换聊天文件行内操作
     * @param {boolean} enabled 是否启用
     * @returns {void}
     */
    setEnabled(enabled) {
        this.enabled = enabled;
        if (enabled) {
            this.enhance();
            return;
        }
        this.container?.querySelectorAll('[data-chat-manager-action]').forEach(button => button.remove());
        this.container?.querySelectorAll('[data-chat-manager-enhanced]').forEach(wrapper => {
            delete wrapper.dataset.chatManagerEnhanced;
        });
    }

    /**
     * 为尚未处理的原生聊天行补充备份与分卷操作
     */
    enhance() {
        if (!this.container || !this.enabled) return;
        for (const wrapper of this.container.querySelectorAll('.select_chat_block_wrapper:not([data-chat-manager-enhanced])')) {
            const actions = wrapper.querySelector('.select_chat_actions');
            if (!actions) continue;
            actions.append(
                this.#icon('backup', 'fa-box-archive', '识别对应备份'),
                this.#icon('split', 'fa-scissors', '分割聊天'),
            );
            wrapper.dataset.chatManagerEnhanced = 'true';
        }
        this.updateRuntimeState();
    }

    /**
     * 根据酒馆生成状态同步分卷按钮
     */
    updateRuntimeState() {
        const disabled = this.isGenerating();
        this.container?.querySelectorAll('[data-chat-manager-action="split"]').forEach(button => {
            button.classList.toggle('cm-native-disabled', disabled);
            button.setAttribute('aria-disabled', String(disabled));
        });
    }

    /**
     * 创建原生聊天行使用的图标按钮
     * @param {string} action 操作名称
     * @param {string} icon Font Awesome 图标类名
     * @param {string} title 无障碍名称与悬停说明
     * @returns {HTMLButtonElement} 操作按钮
     */
    #icon(action, icon, title) {
        return element('button', {
            className: `cm-native-action opacity50p hoverglow fa-solid ${icon}`,
            title,
            type: 'button',
            attrs: { 'data-chat-manager-action': action, 'aria-label': title },
        });
    }

    /**
     * 从原生聊天行提取插件操作所需的聊天信息
     * @param {HTMLElement} row 原生聊天行
     * @returns {object} 规范化聊天记录
     */
    #recordFromRow(row) {
        const context = this.getContext();
        const block = row.querySelector('.select_chat_block[file_name]');
        const fileId = block?.getAttribute('file_name');
        if (!fileId) throw new Error('无法取得聊天文件名');
        const isGroup = context.groupId !== undefined && context.groupId !== null;
        const owner = isGroup
            ? context.groups.find(group => String(group.id) === String(context.groupId))
            : context.characters[context.characterId];
        if (!owner) throw new Error('当前没有有效角色或群聊');
        const countText = row.querySelector('.chat_messages_num')?.textContent ?? '';
        return {
            ownerType: isGroup ? 'group' : 'character',
            ownerId: String(isGroup ? context.groupId : owner.avatar),
            ownerName: String(owner.name ?? ''),
            fileId,
            fileName: `${fileId}.jsonl`,
            fileSize: String(row.querySelector('.chat_file_size')?.textContent ?? '').replace(/[(),]/g, '').trim(),
            messageCount: Number(countText.match(/\d+/)?.[0] ?? 0),
            lastMessageAt: row.querySelector('.chat_messages_date')?.textContent ?? '',
            preview: row.querySelector('.select_chat_block_mes')?.textContent ?? '',
        };
    }

    /**
     * 代理原生聊天文件面板中的插件操作点击
     * @param {MouseEvent} event 点击事件
     */
    #onClick(event) {
        if (!this.enabled) return;
        const button = event.target.closest('[data-chat-manager-action]');
        if (!button || !this.container.contains(button)) return;
        event.preventDefault();
        event.stopPropagation();
        const row = button.closest('.select_chat_block_wrapper');
        try {
            const record = this.#recordFromRow(row);
            if (button.dataset.chatManagerAction === 'backup') this.ui.openBackups(record);
            if (button.dataset.chatManagerAction === 'split') {
                if (this.isGenerating()) throw new Error('聊天正在生成，当前不能分割');
                this.ui.openSplit(record);
            }
        } catch (error) {
            globalThis.toastr?.error?.(error.message);
        }
    }
}
