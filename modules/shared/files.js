/**
 * 移除文件名末尾的 JSONL 扩展名
 * @param {string} name 文件名
 * @returns {string} 文件 ID
 */
export function stripJsonl(name) {
    return String(name ?? '').replace(/\.jsonl$/i, '');
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
