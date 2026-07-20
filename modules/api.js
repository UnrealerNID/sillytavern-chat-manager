import { compressRequest } from '/scripts/request-compression.js';

export class HttpError extends Error {
    /**
     * @param {string} message Error message
     * @param {number} status HTTP status
     * @param {unknown} data Response data
     */
    constructor(message, status, data = null) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.data = data;
    }
}

export class ChatManagerApi {
    /** @param {()=>any} getContext SillyTavern context provider */
    constructor(getContext) {
        this.getContext = getContext;
    }

    /** @returns {Record<string,string>} Native request headers */
    headers(options = {}) {
        return this.getContext().getRequestHeaders(options);
    }

    /**
     * Sends a JSON POST request
     * @param {string} path Endpoint
     * @param {object|undefined} body Request body
     * @param {{signal?:AbortSignal,compress?:boolean,omitContentType?:boolean}} options Options
     * @returns {Promise<any>} JSON response
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
        return this.post('/api/chats/recent', {}, { signal });
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
     * Checks whether a group chat file exists, including unregistered files
     * @param {string} fileId Chat file ID
     * @returns {Promise<boolean>} Whether occupied
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
