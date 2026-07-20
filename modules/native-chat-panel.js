import { element } from './utils.js';

export class NativeChatPanel {
    /**
     * @param {object} options Options
     * @param {()=>any} options.getContext Context provider
     * @param {import('./ui.js').ChatManagerUi} options.ui UI
     * @param {()=>boolean} options.isGenerating Generation state
     */
    constructor({ getContext, ui, isGenerating }) {
        this.getContext = getContext;
        this.ui = ui;
        this.isGenerating = isGenerating;
    }

    init() {
        this.container = document.querySelector('#select_chat_div');
        if (!this.container) return false;
        this.container.addEventListener('click', event => this.#onClick(event));
        this.observer = new MutationObserver(() => this.enhance());
        this.observer.observe(this.container, { childList: true, subtree: true });
        this.enhance();
        return true;
    }

    enhance() {
        if (!this.container) return;
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

    updateRuntimeState() {
        const disabled = this.isGenerating();
        this.container?.querySelectorAll('[data-chat-manager-action="split"]').forEach(button => {
            button.classList.toggle('cm-native-disabled', disabled);
            button.setAttribute('aria-disabled', String(disabled));
        });
    }

    #icon(action, icon, title) {
        return element('button', {
            className: `cm-native-action opacity50p hoverglow fa-solid ${icon}`,
            title,
            type: 'button',
            attrs: { 'data-chat-manager-action': action, 'aria-label': title },
        });
    }

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

    #onClick(event) {
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
