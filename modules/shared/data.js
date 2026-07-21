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
 * 增量解析 JSONL 响应
 * @param {Response} response 网络响应
 * @param {object} options 解析参数
 * @param {(header:object)=>Promise<void>|void} [options.onHeader] 聊天头回调
 * @param {(message:object,index:number)=>Promise<void>|void} [options.onMessage] 消息回调
 * @param {number} [options.stopAfter] 读取指定消息数后停止
 * @returns {Promise<object>} 聊天头与已读取消息数
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
