import {
    groupOwnerRecords,
    groupSplitRecords,
} from '../chat/grouping.js';
import {
    chatKey,
    element,
    stripJsonl,
} from '../shared/utils.js';

/**
 * 在欢迎页最近聊天中复用聊天管理的分组规则
 *
 * 原生聊天卡只会被移动到分组容器中，已有的置顶、重命名、删除和打开事件保持不变
 */
export class WelcomeRecentEnhancer {
    /**
     * @param {object} dependencies 依赖项
     * @param {import('../platform/api.js').ChatManagerApi} dependencies.api 酒馆接口
     * @param {import('./templates.js').UiTemplates} dependencies.templates 模板工具
     * @param {()=>object} dependencies.getOptions 获取共享显示设置
     * @param {(options:object)=>void} dependencies.onOptionsChange 保存共享显示设置
     */
    constructor({ api, templates, getOptions, onOptionsChange }) {
        this.api = api;
        this.templates = templates;
        this.getOptions = getOptions;
        this.onOptionsChange = onOptionsChange;
        this.enabled = true;
        this.session = null;
        this.expandedOwners = new Set();
        this.expandedSplits = new Set();
    }

    /**
     * 观察欢迎页重建并增强当前最近聊天列表
     */
    init() {
        this.chat = document.querySelector('#chat');
        if (!this.chat) return false;
        this.observer = new MutationObserver(() => this.#enhance());
        this.observer.observe(this.chat, { childList: true, subtree: true });
        this.#enhance();
        return true;
    }

    /**
     * 启用或撤销欢迎页增强
     * @param {boolean} enabled 是否启用
     */
    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) {
            this.#restore(this.session, true);
            this.session = null;
            return;
        }
        this.#enhance();
    }

    /**
     * 从聊天管理面板同步分组设置
     * @param {object} options 显示设置
     * @param {boolean} options.groupOwners 是否按角色分组
     * @param {boolean} options.groupSplits 是否按分卷分组
     */
    setGrouping(options) {
        if (!this.session) return;
        this.session.groupOwners = Boolean(options.groupOwners);
        this.session.groupSplits = Boolean(options.groupSplits);
        this.#render(this.session);
    }

    /**
     * 增强当前欢迎页，酒馆重建欢迎页后会创建新会话
     */
    #enhance() {
        if (!this.enabled) return;
        const panel = this.chat?.querySelector('.welcomePanel');
        if (!panel || panel === this.session?.panel || panel.dataset.cmWelcomeEnhanced === 'true') return;
        const list = panel.querySelector('.recentChatList');
        const header = panel.querySelector('.welcomeHeader');
        if (!list || !header) return;

        const rows = Array.from(list.querySelectorAll(':scope > .recentChat'));
        const trailing = Array.from(list.children).filter(node => !node.classList.contains('recentChat'));
        const controls = this.templates.component('welcome-group-controls');
        const ownerButton = this.templates.mount(controls, '[data-cm-welcome-group-owners]', HTMLButtonElement);
        const splitButton = this.templates.mount(controls, '[data-cm-welcome-group-splits]', HTMLButtonElement);
        const options = this.getOptions();
        const session = {
            panel,
            list,
            rows,
            trailing,
            controls,
            ownerButton,
            splitButton,
            groupOwners: Boolean(options.groupOwners),
            groupSplits: Boolean(options.groupSplits),
            metadata: null,
            metadataTask: null,
        };
        // 初始选中状态在控件进入 DOM 前完成，避免刷新后出现状态追赶
        this.#syncButtons(session);
        this.session = session;
        panel.dataset.cmWelcomeEnhanced = 'true';
        panel.classList.add('cm-welcome-enhanced');
        ownerButton.addEventListener('click', () => this.#toggle('owners'));
        splitButton.addEventListener('click', () => this.#toggle('splits'));
        const title = header.querySelector('.recentChatsTitle');
        if (title) title.after(controls);
        else header.prepend(controls);
        this.#render(session);
    }

    /**
     * 切换共享分组设置
     * @param {'owners'|'splits'} type 分组维度
     */
    #toggle(type) {
        const session = this.session;
        if (!session) return;
        if (type === 'owners') session.groupOwners = !session.groupOwners;
        if (type === 'splits') session.groupSplits = !session.groupSplits;
        // 当前面板先完成反馈，另一侧的大列表重绘不能阻塞本次点击
        this.#render(session);
        this.onOptionsChange({
            groupOwners: session.groupOwners,
            groupSplits: session.groupSplits,
        });
    }

    /**
     * 使用原生聊天卡重建当前分组显示
     * @param {object} session 欢迎页会话
     */
    #render(session) {
        if (session !== this.session || !session.panel.isConnected) return;
        this.#restore(session, false);
        this.#syncButtons(session);
        if (!session.groupOwners && !session.groupSplits) return;
        if (session.groupSplits && !session.metadata && !session.metadataTask) {
            void this.#loadMetadata(session);
        }

        const records = session.rows.map(row => this.#record(row, session.metadata));
        session.rowByKey = new Map(records.map((record, index) => [chatKey(record), session.rows[index]]));
        const units = session.groupOwners
            ? groupOwnerRecords(records, session.groupSplits, records)
            : session.groupSplits
                ? groupSplitRecords(records, records)
                : records.map(record => ({ type: 'record', record }));
        session.list.replaceChildren();
        units.forEach(unit => session.list.append(this.#unit(unit, session)));
        session.list.append(...session.trailing);
    }

    /**
     * 从原生最近聊天卡提取分组所需记录
     * @param {HTMLElement} row 原生聊天卡
     * @param {Map<string,object>|null} metadata 聊天元数据索引
     * @returns {object} 规范化聊天记录
     */
    #record(row, metadata) {
        const groupId = row.dataset.group;
        const avatar = row.dataset.avatar;
        const ownerType = groupId ? 'group' : 'character';
        const ownerId = String(groupId || avatar || '');
        const fileId = stripJsonl(row.dataset.file);
        const key = `${ownerType}:${ownerId}:${fileId}`;
        return {
            ownerType,
            ownerId,
            ownerName: row.querySelector('.characterName')?.textContent?.trim() || ownerId,
            avatarUrl: row.querySelector('.avatar img')?.src || '',
            fileId,
            fileName: row.dataset.file || `${fileId}.jsonl`,
            fileSize: row.querySelector('.fileSize')?.textContent?.trim() || '',
            messageCount: Number(row.querySelector('.counterBlock small')?.textContent) || 0,
            lastMessageAt: row.querySelector('.chatDate')?.title || '',
            preview: row.querySelector('.chatMessage')?.textContent?.trim() || '',
            chatManager: metadata?.get(key) ?? null,
        };
    }

    /**
     * 渲染记录、角色组或分卷组
     * @param {object} unit 显示单元
     * @param {object} session 欢迎页会话
     * @returns {HTMLElement} 原生聊天卡或分组容器
     */
    #unit(unit, session) {
        if (unit.type === 'owner-group') return this.#ownerGroup(unit, session);
        if (unit.type === 'split-group') return this.#splitGroup(unit, session);
        return session.rowByKey.get(chatKey(unit.record));
    }

    /**
     * 创建角色分组并保留组内原生聊天卡
     * @param {object} group 角色分组
     * @param {object} session 欢迎页会话
     * @returns {HTMLElement} 角色分组
     */
    #ownerGroup(group, session) {
        const root = this.templates.component('owner-group');
        const image = this.templates.mount(root, '[data-cm-owner-avatar]', HTMLImageElement);
        const children = this.templates.mount(root, '[data-cm-owner-children]');
        const toggle = this.templates.mount(root, '[data-cm-owner-toggle]', HTMLButtonElement);
        image.src = group.avatarUrl;
        image.alt = group.ownerName;
        this.#text(root, '[data-cm-owner-name]', group.ownerName);
        this.#text(root, '[data-cm-owner-summary]', `${group.records.length} 条最近聊天`);
        this.#text(root, '[data-cm-owner-latest]', `最近：${group.records[0]?.fileId ?? ''}`);
        const expanded = this.expandedOwners.has(group.key);
        this.#toggleButton(toggle, expanded, '聊天', () => {
            this.#setExpanded(this.expandedOwners, group.key, expanded);
            this.#render(session);
        });
        if (expanded) {
            children.classList.remove('cm-hidden');
            group.children.forEach(child => children.append(this.#unit(child, session)));
        }
        return root;
    }

    /**
     * 创建分卷分组，最新卷在前且源聊天固定在最后
     * @param {object} group 分卷分组
     * @param {object} session 欢迎页会话
     * @returns {HTMLElement} 分卷分组
     */
    #splitGroup(group, session) {
        const root = this.templates.component('split-group');
        const children = this.templates.mount(root, '[data-cm-split-children]');
        const toggle = this.templates.mount(root, '[data-cm-split-toggle]', HTMLButtonElement);
        this.templates.mount(root, '[data-cm-split-continue]').classList.add('cm-hidden');
        this.#text(root, '[data-cm-split-group-name]', group.rootChatId);
        this.#text(root, '[data-cm-split-group-summary]', `${group.records.length} 个分卷${group.sourceRecord ? ' · 含源聊天' : ''}`);
        this.#text(root, '[data-cm-split-group-latest]', `最新：${group.records.at(-1)?.record.fileId ?? ''}`);
        this.templates.mount(root, '[data-cm-split-group-incremental]').classList.add('cm-hidden');
        const expanded = this.expandedSplits.has(group.key);
        this.#toggleButton(toggle, expanded, '分卷', () => {
            this.#setExpanded(this.expandedSplits, group.key, expanded);
            this.#render(session);
        });
        if (expanded) {
            children.classList.remove('cm-hidden');
            [...group.records]
                .sort((left, right) => right.split.sequence - left.split.sequence)
                .forEach(item => children.append(session.rowByKey.get(chatKey(item.record))));
            if (group.sourceRecord) {
                const sourceRow = session.rowByKey.get(chatKey(group.sourceRecord));
                this.#markSource(sourceRow);
                children.append(sourceRow);
            }
        }
        return root;
    }

    /**
     * 读取聊天头元数据，完成后自动更新当前欢迎页
     * @param {object} session 欢迎页会话
     */
    async #loadMetadata(session) {
        session.metadataTask = this.api.listChatFiles();
        this.#syncButtons(session);
        try {
            const items = await session.metadataTask;
            session.metadata = new Map((Array.isArray(items) ? items : []).map(item => {
                const ownerType = item.group !== undefined && item.group !== null ? 'group' : 'character';
                const ownerId = String(ownerType === 'group' ? item.group : item.avatar);
                const fileId = stripJsonl(item.file_id ?? item.file_name);
                return [`${ownerType}:${ownerId}:${fileId}`, item.chat_metadata?.chat_manager ?? null];
            }));
        } catch (error) {
            console.error('[聊天文件管理] 最近聊天分卷信息读取失败', error);
            globalThis.toastr?.warning?.('最近聊天的分卷信息读取失败');
            session.metadata = new Map();
        } finally {
            session.metadataTask = null;
            if (session === this.session) this.#render(session);
        }
    }

    /**
     * 恢复酒馆生成的原始最近聊天顺序
     * @param {object|null} session 欢迎页会话
     * @param {boolean} removeControls 是否移除插件控件
     */
    #restore(session, removeControls) {
        if (!session?.list) return;
        session.rows.forEach(row => row.querySelector('[data-cm-welcome-source]')?.remove());
        session.list.replaceChildren(...session.rows, ...session.trailing);
        if (removeControls) {
            session.controls.remove();
            session.panel.classList.remove('cm-welcome-enhanced');
            delete session.panel.dataset.cmWelcomeEnhanced;
        }
    }

    /**
     * 同步欢迎页分组开关
     * @param {object} session 欢迎页会话
     */
    #syncButtons(session) {
        for (const [button, active] of [
            [session.ownerButton, session.groupOwners],
            [session.splitButton, session.groupSplits],
        ]) {
            button.classList.toggle('active', active);
            button.setAttribute('aria-checked', String(active));
        }
        session.splitButton.setAttribute('aria-busy', String(Boolean(session.metadataTask)));
        const splitIcon = session.splitButton.querySelector('i');
        splitIcon?.classList.toggle('fa-spin', Boolean(session.metadataTask));
        session.splitButton.title = session.metadataTask ? '正在读取分卷信息' : '按分卷组显示';
    }

    /**
     * 配置分组展开按钮
     * @param {HTMLButtonElement} button 展开按钮
     * @param {boolean} expanded 是否展开
     * @param {string} label 内容名称
     * @param {()=>void} handler 点击处理
     */
    #toggleButton(button, expanded, label, handler) {
        const action = expanded ? '收起' : '展开';
        button.title = `${action}${label}`;
        button.setAttribute('aria-label', `${action}${label}`);
        button.setAttribute('aria-expanded', String(expanded));
        const icon = button.querySelector('[data-cm-group-chevron]');
        icon?.classList.toggle('fa-chevron-up', expanded);
        icon?.classList.toggle('fa-chevron-down', !expanded);
        button.addEventListener('click', handler);
    }

    /**
     * 标记原始聊天
     * @param {HTMLElement} row 原生聊天卡
     */
    #markSource(row) {
        const name = row?.querySelector('.chatName');
        if (!name || name.querySelector('[data-cm-welcome-source]')) return;
        name.append(element('span', {
            className: 'cm-source-badge',
            text: '源',
            attrs: { 'data-cm-welcome-source': '' },
        }));
    }

    /**
     * 更新分组展开集合
     * @param {Set<string>} collection 展开集合
     * @param {string} key 分组键
     * @param {boolean} expanded 当前状态
     */
    #setExpanded(collection, key, expanded) {
        if (expanded) collection.delete(key);
        else collection.add(key);
    }

    /**
     * 设置模板文本
     * @param {ParentNode} root 模板根节点
     * @param {string} selector 选择器
     * @param {string} text 文本
     */
    #text(root, selector, text) {
        this.templates.mount(root, selector).textContent = text;
    }
}
