import {
    deleteCharacterChatByName,
    displayPastChats,
    importCharacterChat,
    isGenerating,
    renameGroupOrCharacterChat,
    updateRemoteChatName,
} from '/script.js';
import {
    deleteGroupChatByName,
    importGroupChat,
} from '/scripts/group-chats.js';
import { callGenericPopup, POPUP_TYPE } from '/scripts/popup.js';
import { renderTemplateAsync } from '/scripts/templates.js';
import { openWelcomeScreen } from '/scripts/welcome-screen.js';

import { stripJsonl } from '../../shared/files.js';

/**
 * 创建聊天文件操作适配器
 * @param {object} dependencies 依赖项
 * @param {()=>any} dependencies.getContext 酒馆上下文提供器
 * @param {import('../api.js').ChatManagerApi} dependencies.api 酒馆接口
 * @param {import('../backups/backups.js').BackupService} dependencies.backups 备份服务
 * @param {(record:object)=>Promise<void>} dependencies.openRecord 打开聊天
 * @returns {object} 恢复备份、删除聊天和重命名聊天的操作集合
 */
export function createChatActions({ getContext, api, backups, openRecord }) {
    return {
        restoreBackup: (record, backup) => restoreBackup(record, backup),
        deleteRecord,
        renameRecord,
    };

    /**
     * 将备份恢复为新聊天
     * @param {object} record 备份所属聊天
     * @param {object} backup 备份信息
     * @returns {Promise<string[]>} 新聊天文件名
     */
    async function restoreBackup(record, backup) {
        if (isGenerating()) throw new Error('聊天正在生成，当前不能恢复备份');
        await openRecord(record);

        const context = getContext();
        const blob = await backups.readBlob(backup);
        const file = new File([blob], backup.file_name, {
            type: 'application/octet-stream',
        });
        const formData = new FormData();
        formData.set('file_type', 'jsonl');
        formData.set('avatar', file);
        formData.set('avatar_url', record.ownerType === 'character' ? record.ownerId : '');
        formData.set('user_name', context.name1);
        formData.set('character_name', record.ownerName);
        const importChat = record.ownerType === 'group'
            ? importGroupChat
            : importCharacterChat;
        const restored = await importChat(formData, { refresh: false });
        if (!restored.length) throw new Error('酒馆未能导入该备份');
        await displayPastChats(restored);
        return restored;
    }

    /**
     * 调用酒馆原生链路删除聊天
     * @param {object} record 待删除聊天
     */
    async function deleteRecord(record) {
        const context = getContext();
        if (record.ownerType === 'character') {
            const characterId = context.characters.findIndex(character => character.avatar === record.ownerId);
            if (characterId < 0) throw new Error(`找不到角色：${record.ownerName}`);
            await deleteCharacterChatByName(String(characterId), record.fileId);
            return;
        }
        const group = context.groups.find(item => String(item.id) === String(record.ownerId));
        if (!group) throw new Error(`找不到群聊：${record.ownerName}`);
        await deleteGroupChatByName(group.id, record.fileId);
    }

    /**
     * 调用酒馆原生链路重命名聊天
     * @param {object} record 待重命名聊天
     * @returns {Promise<boolean>} 是否完成重命名
     */
    async function renameRecord(record) {
        const context = getContext();
        const popup = await renderTemplateAsync('chatRename');
        const input = await callGenericPopup(popup, POPUP_TYPE.INPUT, record.fileId);
        if (typeof input !== 'string') return false;
        const requested = stripJsonl(input.trim());
        const nextFileId = requested ? await api.sanitizeFileName(requested) : '';
        if (!nextFileId || nextFileId === record.fileId) return false;

        if (record.ownerType === 'character') {
            const characterId = context.characters.findIndex(character => character.avatar === record.ownerId);
            if (characterId < 0) throw new Error(`找不到角色：${record.ownerName}`);
            await renameGroupOrCharacterChat({
                characterId: String(characterId),
                oldFileName: record.fileId,
                newFileName: nextFileId,
                loader: false,
            });
            if (!await api.chatExists({ ...record, fileId: nextFileId })) return false;
            await updateRemoteChatName(characterId, nextFileId);
        } else {
            const group = context.groups.find(item => String(item.id) === String(record.ownerId));
            if (!group) throw new Error(`找不到群聊：${record.ownerName}`);
            await renameGroupOrCharacterChat({
                groupId: String(group.id),
                oldFileName: record.fileId,
                newFileName: nextFileId,
                loader: false,
            });
            if (!await api.chatExists({ ...record, fileId: nextFileId })) return false;
        }
        await openWelcomeScreen({ force: true });
        return true;
    }
}
