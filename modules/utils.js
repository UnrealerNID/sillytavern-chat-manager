const textEncoder = new TextEncoder();

/**
 * Deep-clones JSON-compatible SillyTavern data
 * @param {unknown} value Value to clone
 * @returns {any} Cloned value
 */
export function cloneJson(value) {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

/**
 * Removes a trailing JSONL extension
 * @param {string} name File name
 * @returns {string} File ID
 */
export function stripJsonl(name) {
    return String(name ?? '').replace(/\.jsonl$/i, '');
}

/**
 * 判断候选语义版本是否高于当前版本
 * @param {string} candidate 候选版本
 * @param {string} current 当前版本
 * @returns {boolean} 候选版本是否更新
 */
export function isNewerVersion(candidate, current) {
    const parse = value => /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value ?? '').trim());
    const candidateParts = parse(candidate);
    const currentParts = parse(current);
    if (!candidateParts || !currentParts) return false;

    for (let index = 1; index <= 3; index++) {
        const difference = Number(candidateParts[index]) - Number(currentParts[index]);
        if (difference !== 0) return difference > 0;
    }
    return false;
}

/**
 * Returns the stable owner key for a chat record
 * @param {ChatRecord} record Chat record
 * @returns {string} Stable key
 */
export function chatKey(record) {
    return `${record.ownerType}:${record.ownerId}:${record.fileId}`;
}

/**
 * Produces deterministic JSON by recursively sorting object keys
 * @param {unknown} value JSON value
 * @returns {string} Canonical JSON
 */
export function canonicalJson(value) {
    const normalize = (item) => {
        if (Array.isArray(item)) return item.map(normalize);
        if (item && typeof item === 'object') {
            return Object.keys(item).sort().reduce((result, key) => {
                result[key] = normalize(item[key]);
                return result;
            }, {});
        }
        return item;
    };
    return JSON.stringify(normalize(value));
}

/**
 * Computes a SHA-256 byte digest
 * @param {BufferSource|string} value Input value
 * @returns {Promise<Uint8Array>} Digest bytes
 */
export async function sha256(value) {
    const bytes = typeof value === 'string' ? textEncoder.encode(value) : value;
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/**
 * Converts bytes to lowercase hexadecimal
 * @param {Uint8Array} bytes Bytes
 * @returns {string} Hex string
 */
export function toHex(bytes) {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Computes one canonical message digest
 * @param {object} message Message object
 * @returns {Promise<Uint8Array>} Digest bytes
 */
export function digestMessage(message) {
    return sha256(canonicalJson(message));
}

/**
 * Computes an ordered aggregate digest without joining all message JSON
 * @param {object[]} messages Messages
 * @returns {Promise<string>} Aggregate digest
 */
export async function digestMessages(messages) {
    const aggregate = new Uint8Array(messages.length * 32);
    for (let index = 0; index < messages.length; index++) {
        aggregate.set(await digestMessage(messages[index]), index * 32);
    }
    return toHex(await sha256(aggregate));
}

/**
 * Calculates exact UTF-8 JSONL bytes for a chat payload
 * @param {object} header Chat header
 * @param {object[]} messages Messages
 * @returns {number} Byte count
 */
export function jsonlByteSize(header, messages) {
    let size = textEncoder.encode(JSON.stringify(header)).byteLength;
    for (const message of messages) {
        size += 1 + textEncoder.encode(JSON.stringify(message)).byteLength;
    }
    return size;
}

/**
 * Formats a byte count for display
 * @param {number} bytes Bytes
 * @returns {string} Human-readable size
 */
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** unit);
    return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

/**
 * Builds inclusive split ranges
 * @param {number} start First floor
 * @param {number} end Last floor
 * @param {number|null} chunkSize Optional fixed floor count
 * @returns {{start:number,end:number,count:number}[]} Ranges
 */
export function buildRanges(start, end, chunkSize = null) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
        throw new Error('楼层范围无效');
    }
    if (chunkSize === null) return [{ start, end, count: end - start + 1 }];
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('每卷楼层数必须大于 0');
    const ranges = [];
    for (let cursor = start; cursor <= end; cursor += chunkSize) {
        const rangeEnd = Math.min(end, cursor + chunkSize - 1);
        ranges.push({ start: cursor, end: rangeEnd, count: rangeEnd - cursor + 1 });
    }
    return ranges;
}

/**
 * Parses a JSONL response incrementally
 * @param {Response} response Fetch response
 * @param {{onHeader?:(header:object)=>Promise<void>|void,onMessage?:(message:object,index:number)=>Promise<void>|void,stopAfter?:number}} options Parse options
 * @returns {Promise<{header:object,messageCount:number}>} Parse result
 */
export async function parseJsonlResponse(response, options = {}) {
    if (!response.body) throw new Error('响应不支持流式读取');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lineNumber = 0;
    let header;
    let messageCount = 0;

    const consume = async (line) => {
        if (!line.trim()) return false;
        let value;
        try {
            value = JSON.parse(line);
        } catch {
            throw new Error(`JSONL 第 ${lineNumber} 行损坏`);
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(`JSONL 第 ${lineNumber} 行不是对象`);
        }
        if (lineNumber === 1) {
            header = value;
            await options.onHeader?.(value);
            return false;
        }
        const index = messageCount++;
        await options.onMessage?.(value, index);
        return Number.isInteger(options.stopAfter) && messageCount >= options.stopAfter;
    };

    try {
        while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const lines = buffer.split(/\r?\n/);
            buffer = done ? '' : lines.pop() ?? '';
            if (done && buffer) lines.push(buffer);
            for (const line of lines) {
                lineNumber++;
                if (await consume(line)) {
                    await reader.cancel();
                    return { header, messageCount };
                }
            }
            if (done) break;
        }
    } finally {
        reader.releaseLock();
    }
    if (!header) throw new Error('备份缺少聊天头');
    return { header, messageCount };
}

/**
 * Creates a DOM element without interpolating untrusted HTML
 * @param {string} tag Tag name
 * @param {{className?:string,text?:string,title?:string,type?:string,attrs?:Record<string,string>}} options Element options
 * @returns {HTMLElement} Element
 */
export function element(tag, options = {}) {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = options.text;
    if (options.title) node.title = options.title;
    if (options.type && node instanceof HTMLButtonElement) node.type = options.type;
    for (const [name, value] of Object.entries(options.attrs ?? {})) node.setAttribute(name, value);
    return node;
}

/**
 * @typedef {object} ChatRecord
 * @property {'character'|'group'} ownerType
 * @property {string} ownerId
 * @property {string} ownerName
 * @property {string} avatarUrl
 * @property {string} fileId
 * @property {string} fileName
 * @property {string} fileSize
 * @property {number} messageCount
 * @property {string|number} lastMessageAt
 * @property {string} preview
 */
