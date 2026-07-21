/**
 * 管理数据清理备份条目的批量选择会话
 */
export class DataMaidSelection {
    /**
     * @param {object} options 配置项
     * @param {()=>Map<string,object>} options.getItems 获取备份条目
     * @param {()=>boolean} options.isBusy 是否处于加载或删除状态
     * @param {(items:object[])=>void} options.onDelete 请求删除回调
     */
    constructor({ getItems, isBusy, onDelete }) {
        this.getItems = getItems;
        this.isBusy = isBusy;
        this.onDelete = onDelete;
        this.selected = new Map();
        this.mode = false;
    }

    /**
     * 挂载批量选择工具栏
     * @param {object} controls 工具栏控件
     */
    mount(controls) {
        this.controls = controls;
        controls.batchStart.addEventListener('click', () => this.setMode(!this.mode));
        controls.selectAll.addEventListener('click', () => this.#toggleAll());
        controls.clearSelection.addEventListener('click', () => this.clear());
        controls.deleteSelected.addEventListener('click', () => this.onDelete(Array.from(this.selected.values())));
        this.setMode(false);
    }

    /**
     * 绑定单个备份条目的选择框
     * @param {object} item 备份条目
     */
    bindItem(item) {
        item.checkbox.addEventListener('change', () => {
            const hash = item.record.hash;
            if (item.checkbox.checked) this.selected.set(hash, item);
            else this.selected.delete(hash);
            item.element?.classList.toggle('cm-selected', item.checkbox.checked);
            this.sync();
        });
    }

    /**
     * 同步条目可见性并清理隐藏选择
     * @param {object} item 备份条目
     * @param {boolean} visible 是否可见
     */
    setVisible(item, visible) {
        if (visible || !this.selected.has(item.record.hash)) return;
        this.selected.delete(item.record.hash);
        if (item.checkbox) item.checkbox.checked = false;
        item.element?.classList.remove('cm-selected');
    }

    /**
     * 从选择会话移除已删除条目
     * @param {object} item 备份条目
     */
    remove(item) {
        this.selected.delete(item.record.hash);
    }

    /**
     * 切换批量选择模式
     * @param {boolean} enabled 是否启用
     */
    setMode(enabled) {
        if (enabled && this.isBusy()) return;
        this.mode = enabled;
        if (!enabled) this.clear(false);
        const controls = this.controls;
        controls?.category.classList.toggle('cm-data-maid-selection-mode', enabled);
        controls?.selectionToolbar.classList.toggle('cm-hidden', !enabled);
        controls?.batchStart.classList.toggle('active', enabled);
        controls?.batchStart.setAttribute('aria-pressed', String(enabled));
        const action = enabled ? '退出批量选择' : '进入批量选择';
        if (controls?.batchStart) {
            controls.batchStart.title = action;
            controls.batchStart.setAttribute('aria-label', action);
        }
        this.sync();
    }

    /**
     * 清除全部选择
     * @param {boolean} sync 是否立即同步控件
     */
    clear(sync = true) {
        this.selected.clear();
        for (const item of this.getItems().values()) {
            if (item.checkbox) item.checkbox.checked = false;
            item.element?.classList.remove('cm-selected');
        }
        if (sync) this.sync();
    }

    /**
     * 重置当前批量选择会话
     */
    reset() {
        this.clear(false);
        this.mode = false;
        this.controls = null;
    }

    /**
     * 同步批量选择工具栏状态
     */
    sync() {
        const controls = this.controls;
        if (!controls) return;
        for (const [hash, item] of this.selected) {
            if (!item.element?.isConnected) this.selected.delete(hash);
        }
        const visible = this.#visibleItems();
        const allSelected = visible.length > 0 && visible.every(item => this.selected.has(item.record.hash));
        const busy = this.isBusy();
        const selectAction = allSelected ? '取消全选当前结果' : '全选当前结果';
        controls.batchStart.disabled = busy;
        controls.selectAll.disabled = busy || visible.length === 0;
        controls.selectAll.title = selectAction;
        controls.selectAll.setAttribute('aria-label', selectAction);
        controls.clearSelection.disabled = busy || this.selected.size === 0;
        controls.deleteSelected.disabled = busy || this.selected.size === 0;
        controls.selectedCount.textContent = `已选 ${this.selected.size} 项`;
    }

    /**
     * 切换当前可见结果的全选状态
     */
    #toggleAll() {
        if (!this.mode) return;
        const visible = this.#visibleItems();
        const allSelected = visible.length > 0 && visible.every(item => this.selected.has(item.record.hash));
        for (const item of visible) {
            item.checkbox.checked = !allSelected;
            if (allSelected) this.selected.delete(item.record.hash);
            else this.selected.set(item.record.hash, item);
            item.element.classList.toggle('cm-selected', !allSelected);
        }
        this.sync();
    }

    /**
     * 获取当前可见的备份条目
     * @returns {object[]} 可见条目
     */
    #visibleItems() {
        return Array.from(this.getItems().values()).filter(item => (
            item.element?.isConnected && !item.element.classList.contains('cm-hidden')
        ));
    }
}
