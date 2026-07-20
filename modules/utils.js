const textEncoder = new TextEncoder();

/**
 * 深拷贝兼容 JSON 的酒馆数据
 * @param {unknown} value 待拷贝的值
 * @returns {any} 拷贝结果
 */
export function cloneJson(value) {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

/**
 * 移除文件名末尾的 JSONL 扩展名
 * @param {string} name 文件名
 * @returns {string} 文件 ID
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
 * 生成聊天记录的稳定所有者键
 * @param {ChatRecord} record 聊天记录
 * @returns {string} 稳定键
 */
export function chatKey(record) {
    return `${record.ownerType}:${record.ownerId}:${record.fileId}`;
}

/**
 * 递归排序对象键并生成确定性 JSON
 * @param {unknown} value JSON 值
 * @returns {string} 规范化 JSON
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
 * 计算 SHA-256 字节摘要
 * @param {BufferSource|string} value 输入值
 * @returns {Promise<Uint8Array>} 摘要字节
 */
export async function sha256(value) {
    const bytes = typeof value === 'string' ? textEncoder.encode(value) : value;
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/**
 * 将字节转换为小写十六进制文本
 * @param {Uint8Array} bytes 字节数组
 * @returns {string} 十六进制文本
 */
export function toHex(bytes) {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 计算单条规范化消息摘要
 * @param {object} message 消息对象
 * @returns {Promise<Uint8Array>} 摘要字节
 */
export function digestMessage(message) {
    return sha256(canonicalJson(message));
}

/**
 * 不拼接全部消息 JSON，按顺序计算聚合摘要
 * @param {object[]} messages 消息列表
 * @returns {Promise<string>} 聚合摘要
 */
export async function digestMessages(messages) {
    const aggregate = new Uint8Array(messages.length * 32);
    for (let index = 0; index < messages.length; index++) {
        aggregate.set(await digestMessage(messages[index]), index * 32);
    }
    return toHex(await sha256(aggregate));
}

/**
 * 计算聊天载荷准确的 UTF-8 JSONL 字节数
 * @param {object} header 聊天头
 * @param {object[]} messages 消息列表
 * @returns {number} 字节数
 */
export function jsonlByteSize(header, messages) {
    let size = textEncoder.encode(JSON.stringify(header)).byteLength;
    for (const message of messages) {
        size += 1 + textEncoder.encode(JSON.stringify(message)).byteLength;
    }
    return size;
}

/**
 * 将字节数格式化为可读大小
 * @param {number} bytes 字节数
 * @returns {string} 可读大小
 */
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** unit);
    return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

/**
 * 将酒馆返回的可读文件大小转换为字节数
 * @param {string|number} value 文件大小
 * @returns {number} 字节数，无法识别时返回零
 */
export function parseBytes(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
    const match = String(value ?? '').trim().match(/^([\d.]+)\s*(B|KB|KIB|MB|MIB|GB|GIB)$/i);
    if (!match) return 0;
    const amount = Number(match[1]);
    const units = { B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3 };
    return Number.isFinite(amount) ? amount * (1024 ** units[match[2].toUpperCase()]) : 0;
}

/**
 * 构建包含首尾楼层的分割范围
 * @param {number} start 起始楼层
 * @param {number} end 结束楼层
 * @param {number|null} chunkSize 可选的固定楼层数
 * @returns {{start:number,end:number,count:number}[]} 分割范围
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
 * 增量解析 JSONL 响应
 * @param {Response} response 网络响应
 * @param {{onHeader?:(header:object)=>Promise<void>|void,onMessage?:(message:object,index:number)=>Promise<void>|void,stopAfter?:number}} options 解析参数
 * @returns {Promise<{header:object,messageCount:number}>} 解析结果
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
            return options.stopAfter === 0;
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
 * 创建 DOM 元素，不插入不可信 HTML
 * @param {string} tag 标签名
 * @param {{className?:string,text?:string,title?:string,type?:string,attrs?:Record<string,string>}} options 元素参数
 * @returns {HTMLElement} 元素
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
 * @property {'character'|'group'} ownerType 所有者类型
 * @property {string} ownerId 所有者 ID
 * @property {string} ownerName 所有者名称
 * @property {string} avatarUrl 头像地址
 * @property {string} fileId 聊天文件 ID
 * @property {string} fileName 聊天文件名
 * @property {string} fileSize 文件大小
 * @property {number} messageCount 消息数量
 * @property {string|number} lastMessageAt 最后消息时间
 * @property {string} preview 最后消息预览
 * @property {object|null} chatManager 插件写入聊天头的分卷元数据
 */
