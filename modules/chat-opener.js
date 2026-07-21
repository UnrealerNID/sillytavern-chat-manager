/**
 * 在一次操作中切换所有者并打开指定聊天文件
 * @param {object} record 目标聊天
 * @param {object} dependencies 酒馆原生能力
 * @param {()=>any} dependencies.getContext 上下文提供器
 * @param {()=>boolean} dependencies.isGenerating 生成状态
 * @param {(groupId:string)=>Promise<unknown>} dependencies.openGroupById 打开群组
 * @param {(owner:string)=>void} dependencies.setActiveCharacter 保存活动角色
 * @param {(owner:string)=>void} dependencies.setActiveGroup 保存活动群组
 */
export async function openChatRecord(record, dependencies) {
    const {
        getContext,
        isGenerating,
        openGroupById,
        setActiveCharacter,
        setActiveGroup,
    } = dependencies;
    if (isGenerating()) throw new Error('聊天正在生成，当前不能切换聊天');
    const context = getContext();
    if (record.ownerType === 'character') {
        await openCharacter(record, context, {
            getContext,
            setActiveCharacter,
        });
        return;
    }
    await openGroup(record, context, {
        getContext,
        openGroupById,
        setActiveGroup,
    });
}

/**
 * 打开角色聊天
 * @param {object} record 目标聊天
 * @param {object} context 酒馆上下文
 * @param {object} dependencies 原生能力
 */
async function openCharacter(record, context, { getContext, setActiveCharacter }) {
    const characterId = context.characters.findIndex(character => (
        character.avatar === record.ownerId
    ));
    if (characterId < 0) throw new Error('目标角色已不存在');
    const currentCharacter = context.characters[context.characterId];
    const ownerChanged = context.groupId !== undefined && context.groupId !== null
        || currentCharacter?.avatar !== record.ownerId;
    if (ownerChanged) await context.selectCharacterById(characterId);
    setActiveCharacter(record.ownerId);
    getContext().saveSettingsDebounced();
    if (ownerChanged || getContext().getCurrentChatId() !== record.fileId) {
        await getContext().openCharacterChat(record.fileId);
    }
    const opened = getContext();
    const correctOwner = opened.characters[opened.characterId]?.avatar === record.ownerId;
    if (!correctOwner || opened.getCurrentChatId() !== record.fileId) {
        throw new Error('酒馆未能切换到目标聊天');
    }
}

/**
 * 打开群组聊天
 * @param {object} record 目标聊天
 * @param {object} context 酒馆上下文
 * @param {object} dependencies 原生能力
 */
async function openGroup(record, context, { getContext, openGroupById, setActiveGroup }) {
    const group = context.groups.find(item => String(item.id) === String(record.ownerId));
    if (!group) throw new Error('目标群组已不存在');
    if (!group.chats?.includes(record.fileId)) throw new Error('目标聊天已不在群组登记中');
    const ownerChanged = String(context.groupId ?? '') !== String(record.ownerId);
    if (ownerChanged) await openGroupById(record.ownerId);
    setActiveGroup(record.ownerId);
    getContext().saveSettingsDebounced();
    if (ownerChanged || getContext().getCurrentChatId() !== record.fileId) {
        await getContext().openGroupChat(record.ownerId, record.fileId);
    }
    const opened = getContext();
    const correctOwner = String(opened.groupId ?? '') === String(record.ownerId);
    if (!correctOwner || opened.getCurrentChatId() !== record.fileId) {
        throw new Error('酒馆未能切换到目标聊天');
    }
}
