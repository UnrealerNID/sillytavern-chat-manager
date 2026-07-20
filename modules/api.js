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

    getRecentChats(signal) {
        return this.post('/api/chats/recent', { metadata: true }, { signal });
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

    listBackups(signal) {
        return this.post('/api/backups/chat/get', undefined, { signal });
    }

    async downloadBackup(name, signal) {
        const response = await fetch('/api/backups/chat/download', {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ name }),
            cache: 'no-cache',
            signal,
        });
        if (!response.ok) throw new HttpError('备份下载失败', response.status);
        return response;
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
}
