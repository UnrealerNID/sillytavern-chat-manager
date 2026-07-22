const LOW_DETAIL_IMAGE_TOKENS = 85;
const IMAGE_TILE_TOKENS = 170;
const VIDEO_TOKEN_ESTIMATE = 1000;

/**
 * 按酒馆助手提示词查看器的规则计算一条最终消息
 * @param {object} message 聊天补全消息
 * @param {(text:string)=>Promise<number>} countTextTokens 文本 Token 计算器
 * @param {(url:string)=>Promise<{width:number,height:number}>} [getImageSize] 图片尺寸读取器
 * @returns {Promise<number>} 消息 Token 数
 */
export async function countPromptMessageTokens(message, countTextTokens, getImageSize) {
    const content = message?.content;
    if (!content) {
        return message?.role === 'assistant' && message?.tool_calls
            ? countTextTokens(JSON.stringify(message.tool_calls))
            : 0;
    }
    if (typeof content === 'string') return countTextTokens(content);
    if (!Array.isArray(content)) return countTextTokens(JSON.stringify(content));
    const counts = await Promise.all(content.map(item => {
        return countContentPart(item, countTextTokens, getImageSize);
    }));
    return counts.reduce((total, count) => total + count, 0);
}

async function countContentPart(item, countTextTokens, getImageSize) {
    if (item?.type === 'text') return countTextTokens(String(item.text ?? ''));
    if (item?.type === 'image_url') {
        return countImageTokens(item.image_url?.url, item.image_url?.detail, getImageSize);
    }
    if (item?.type === 'video_url') return VIDEO_TOKEN_ESTIMATE;
    return 0;
}

async function countImageTokens(url, detail, getImageSize) {
    if (!url) return 0;
    if (detail === 'low') return LOW_DETAIL_IMAGE_TOKENS;
    if (!getImageSize) return LOW_DETAIL_IMAGE_TOKENS;
    try {
        const size = await getImageSize(url);
        if (detail === 'auto' && size.width <= 512 && size.height <= 512) {
            return LOW_DETAIL_IMAGE_TOKENS;
        }
        const scale = 2048 / Math.min(size.width, size.height);
        const scaledWidth = Math.round(size.width * scale);
        const scaledHeight = Math.round(size.height * scale);
        const finalScale = 768 / Math.min(scaledWidth, scaledHeight);
        const finalWidth = Math.round(scaledWidth * finalScale);
        const finalHeight = Math.round(scaledHeight * finalScale);
        const tiles = Math.ceil(finalWidth / 512) * Math.ceil(finalHeight / 512);
        return tiles * IMAGE_TILE_TOKENS + LOW_DETAIL_IMAGE_TOKENS;
    } catch (error) {
        console.warn('[酒馆工具箱] 无法读取提示词图片尺寸，按低清图像计数', error);
        return LOW_DETAIL_IMAGE_TOKENS;
    }
}
