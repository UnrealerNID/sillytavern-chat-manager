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
