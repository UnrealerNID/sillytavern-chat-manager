import test from 'node:test';
import assert from 'node:assert/strict';

import { openChatRecord } from '../modules/chat/chat-opener.js';

test('opens a character chat completely in one call', async () => {
    let currentChat = '角色甲聊天';
    let selected = 0;
    let opened = 0;
    const context = {
        characters: [{ avatar: '甲.png' }, { avatar: '乙.png' }],
        groups: [],
        characterId: 0,
        groupId: null,
        async selectCharacterById(id) {
            selected++;
            this.characterId = id;
            currentChat = '角色乙默认聊天';
        },
        async openCharacterChat(fileId) {
            opened++;
            currentChat = fileId;
        },
        getCurrentChatId: () => currentChat,
        saveSettingsDebounced() {},
    };

    await openChatRecord({ ownerType: 'character', ownerId: '乙.png', fileId: '目标聊天' }, {
        getContext: () => context,
        isGenerating: () => false,
        openGroupById: async () => {},
        setActiveCharacter: () => {},
        setActiveGroup: () => {},
    });

    assert.equal(selected, 1);
    assert.equal(opened, 1);
    assert.equal(context.characterId, 1);
    assert.equal(currentChat, '目标聊天');
});

test('opens a group chat completely in one call', async () => {
    let currentChat = '旧聊天';
    let openedGroup = 0;
    let openedChat = 0;
    const context = {
        characters: [],
        groups: [{ id: 'group-2', chats: ['目标群聊'] }],
        characterId: null,
        groupId: 'group-1',
        getCurrentChatId: () => currentChat,
        async openGroupChat(_groupId, fileId) {
            openedChat++;
            currentChat = fileId;
        },
        saveSettingsDebounced() {},
    };

    await openChatRecord({ ownerType: 'group', ownerId: 'group-2', fileId: '目标群聊' }, {
        getContext: () => context,
        isGenerating: () => false,
        openGroupById: async groupId => {
            openedGroup++;
            context.groupId = groupId;
            currentChat = '群组默认聊天';
        },
        setActiveCharacter: () => {},
        setActiveGroup: () => {},
    });

    assert.equal(openedGroup, 1);
    assert.equal(openedChat, 1);
    assert.equal(context.groupId, 'group-2');
    assert.equal(currentChat, '目标群聊');
});
