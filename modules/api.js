import { compressRequest } from '/scripts/request-compression.js';

export class HttpError extends Error {
    /**
     * @param {string} message 错误信息
     * @param {number} status HTTP 状态码
     * @param {unknown} data 响应数据
     */
    constructor(message, status, data = null) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.data = data;
    }
}

export class ChatManagerApi {
    /** @param {()=>any} getContext 酒馆上下文提供器 */
    constructor(getContext) {
        this.getContext = getContext;
    }

    /** @returns {Record<string,string>} 原生请求头 */
    headers(options = {}) {
        return this.getContext().getRequestHeaders(options);
    }

    /**
     * 发送 JSON POST 请求
     * @param {string} path 接口路径
     * @param {object|undefined} body 请求体
     * @param {{signal?:AbortSignal,compress?:boolean,omitContentType?:boolean}} options 请求选项
     * @returns {Promise<any>} JSON 响应
     */
    async post(path, body = undefined, options = {}) {
        let request = {
            method: 'POST',
            headers: this.headers({ omitContentType: !!options.omitContentType }),
            cache: 'no-cache',
            signal: options.signal,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        };
        if (options.compress) request = await compressRequest(request);
        const response = await fetch(path, request);
        let data = null;
        try {
            data = await response.json();
        } catch {
            data = null;
        }
        if (!response.ok) throw new HttpError(`${path} 请求失败`, response.status, data);
        return data;
    }

    /**
     * 调用酒馆的 recent 接口扫描当前全部聊天文件
     * @param {AbortSignal} [signal] 取消信号
     * @returns {Promise<object[]>} 实时聊天文件信息
     */
    listChatFiles(signal) {
        return this.post('/api/chats/recent', { metadata: true }, { signal });
    }

    /**
     * 只读取当前角色或群组的聊天文件信息
     * @param {{ownerType:'character'|'group',ownerId:string}} owner 当前所有者
     * @param {AbortSignal} [signal] 取消信号
     * @returns {Promise<object[]>} 当前所有者的聊天文件信息
     */
    async listOwnerChatFiles(owner, signal) {
        if (owner.ownerType === 'character') {
            const items = await this.getCharacterChats(owner.ownerId, { metadata: true, signal });
            return Array.isArray(items) ? items.map(item => ({ ...item, avatar: owner.ownerId })) : [];
        }
        const groups = Array.isArray(this.getContext().groups) ? this.getContext().groups : [];
        const group = groups.find(item => String(item.id) === String(owner.ownerId));
        if (!group || !Array.isArray(group.chats)) return [];
        const settled = await Promise.allSettled(group.chats.map(fileId => this.getGroupInfo(fileId, signal)));
        return settled
            .filter(result => result.status === 'fulfilled' && result.value?.file_name)
            .map(result => ({ ...result.value, group: group.id }));
    }

    getCharacterChats(avatar, options = {}) {
        return this.post('/api/characters/chats', {
            avatar_url: avatar,
            simple: !!options.simple,
            metadata: !!options.metadata,
        }, { signal: options.signal });
    }

    getCharacterChat(avatar, fileId, signal) {
        return this.post('/api/chats/get', { avatar_url: avatar, file_name: fileId }, { signal });
    }

    getGroupChat(fileId, signal) {
        return this.post('/api/chats/group/get', { id: fileId }, { signal });
    }

    getGroupInfo(fileId, signal) {
        return this.post('/api/chats/group/info', { id: fileId }, { signal });
    }

    /**
     * 调用酒馆数据清理报告识别孤立聊天文件
     * @param {AbortSignal} [signal] 取消信号
     * @returns {Promise<{report:object,token:string}>} 清理报告与临时访问令牌
     */
    createDataMaidReport(signal) {
        return this.post('/api/data-maid/report', undefined, { signal });
    }

    /**
     * 释放酒馆数据清理报告的临时访问令牌
     * @param {string} token 临时访问令牌
     * @returns {Promise<void>}
     */
    async finalizeDataMaidReport(token) {
        if (!token) return;
        await this.post('/api/data-maid/finalize', { token });
    }

    /**
     * 读取数据清理报告中的文件
     * @param {string} token 临时访问令牌
     * @param {string} hash 文件路径摘要
     * @param {AbortSignal} [signal] 取消信号
     * @returns {Promise<Response>} 原始文件响应
     */
    async readDataMaidFile(token, hash, signal) {
        const query = new URLSearchParams({ token, hash });
        const response = await fetch(`/api/data-maid/view?${query}`, { cache: 'no-cache', signal });
        if (!response.ok) throw new HttpError('孤立聊天文件读取失败', response.status);
        return response;
    }

    /**
     * 使用酒馆数据清理令牌批量删除已确认的文件
     * @param {string} token 临时访问令牌
     * @param {string[]} hashes 文件路径摘要
     * @returns {Promise<void>}
     */
    async deleteDataMaidFiles(token, hashes) {
        if (!token || !hashes.length) return;
        await this.post('/api/data-maid/delete', { token, hashes });
    }

    async sanitizeFileName(fileName) {
        const result = await this.post('/api/files/sanitize-filename', { fileName });
        return String(result?.fileName ?? '');
    }

    saveCharacterChat(avatar, fileId, chat) {
        return this.post('/api/chats/save', {
            avatar_url: avatar,
            file_name: fileId,
            chat,
            force: false,
        }, { compress: true });
    }

    saveGroupChat(fileId, chat) {
        return this.post('/api/chats/group/save', { id: fileId, chat, force: false }, { compress: true });
    }

    getGroups() {
        return this.post('/api/groups/all', undefined, { omitContentType: true });
    }

    editGroup(group) {
        return this.post('/api/groups/edit', group);
    }

    /**
     * 检查群聊文件是否存在，包括尚未登记的文件
     * @param {string} fileId 聊天文件 ID
     * @returns {Promise<boolean>} 名称是否已占用
     */
    async groupChatExists(fileId) {
        const response = await fetch('/api/chats/export', {
            method: 'POST',
            headers: this.headers(),
            cache: 'no-cache',
            body: JSON.stringify({
                is_group: true,
                file: `${fileId}.jsonl`,
                exportfilename: `${fileId}.jsonl`,
                format: 'jsonl',
            }),
        });
        if (response.status === 404) return false;
        if (!response.ok) throw new HttpError('群聊文件占用检查失败', response.status);
        await response.body?.cancel();
        return true;
    }

    /**
     * 检查指定聊天文件是否仍然存在
     * @param {import('./utils.js').ChatRecord} record 聊天记录
     * @returns {Promise<boolean>} 文件是否存在
     */
    async chatExists(record) {
        if (record.ownerType === 'group') return this.groupChatExists(record.fileId);
        const chats = await this.getCharacterChats(record.ownerId, { simple: true });
        return Array.isArray(chats) && chats.some(item => String(item.file_name ?? '').replace(/\.jsonl$/i, '') === record.fileId);
    }
}
