import { stripJsonl } from '../../shared/files.js';

/**
 * 串行合并聊天清单读取，并只返回最新范围的数据
 */
export class ChatInventory {
    /**
     * @param {object} options 配置项
     * @param {import('../api.js').ChatManagerApi} options.api 酒馆接口
     * @param {()=>any} options.getContext 上下文提供器
     * @param {()=>object} options.getTarget 获取最新清单范围
     * @param {(record:object)=>string} options.getAvatarUrl 头像地址生成器
     * @param {(loading:boolean)=>void} options.onLoading 加载状态回调
     */
    constructor({ api, getContext, getTarget, getAvatarUrl, onLoading }) {
        this.api = api;
        this.getContext = getContext;
        this.getTarget = getTarget;
        this.getAvatarUrl = getAvatarUrl;
        this.onLoading = onLoading;
        this.requested = false;
        this.task = null;
    }

    /**
     * 请求同步当前范围，并合并同步期间产生的新请求
     * @returns {Promise<object[]>} 最新范围的聊天记录
     */
    refresh() {
        this.requested = true;
        this.task ??= this.#drain().finally(() => {
            this.task = null;
        });
        return this.task;
    }

    /**
     * 持续读取到没有更新的范围请求为止
     * @returns {Promise<object[]>} 最新稳定记录
     */
    async #drain() {
        this.onLoading(true);
        let records = [];
        try {
            while (this.requested) {
                this.requested = false;
                const target = this.getTarget();
                const loaded = await this.#load(target);
                if (target.key === this.getTarget().key) records = loaded;
                else this.requested = true;
            }
            return records;
        } finally {
            this.onLoading(false);
        }
    }

    /**
     * 读取并规范化指定范围
     * @param {object} target 清单读取目标
     * @param {'current'|'all'} target.scope 聊天范围
     * @param {object|null} target.owner 当前所有者
     * @returns {Promise<object[]>} 规范化聊天记录
     */
    async #load(target) {
        const data = target.scope === 'current' && target.owner
            ? await this.api.listOwnerChatFiles(target.owner)
            : await this.api.listChatFiles();
        if (!Array.isArray(data)) throw new Error('聊天文件接口返回格式无效');
        const context = this.getContext();
        const characters = new Map((context.characters ?? []).map(character => [character.avatar, character]));
        const groups = new Map((context.groups ?? []).map(group => [String(group.id), group]));
        return data.map(item => {
            const isGroup = item.group !== undefined && item.group !== null;
            const owner = isGroup
                ? groups.get(String(item.group))
                : characters.get(item.avatar);
            if (!owner) return null;
            const record = {
                ownerType: isGroup ? 'group' : 'character',
                ownerId: String(isGroup ? item.group : item.avatar),
                ownerName: String(owner.name ?? item.char_name ?? item.group ?? item.avatar),
                fileId: stripJsonl(item.file_id ?? item.file_name),
                fileName: String(item.file_name ?? `${item.file_id}.jsonl`),
                fileSize: String(item.file_size ?? ''),
                messageCount: Number(item.chat_items ?? 0),
                lastMessageAt: item.last_mes ?? '',
                preview: String(item.mes ?? ''),
                chatManager: item.chat_metadata?.chat_manager ?? null,
            };
            record.avatarUrl = this.getAvatarUrl(record);
            return record;
        }).filter(Boolean).sort((left, right) => (
            new Date(right.lastMessageAt).valueOf() - new Date(left.lastMessageAt).valueOf()
        ));
    }
}
