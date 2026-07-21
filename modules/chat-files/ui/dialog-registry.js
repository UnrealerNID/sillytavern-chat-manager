/**
 * 管理活动弹窗及不可中断操作的延迟关闭
 */
export class DialogRegistry {
    constructor() {
        this.entries = new Set();
    }

    /**
     * 登记一个弹窗生命周期
     * @param {Function} onClose 实际关闭回调
     * @param {Function} onClosableChange 可关闭状态回调
     * @returns {object} 关闭与状态控制方法
     */
    register(onClose, onClosableChange) {
        const entry = {
            closable: true,
            closeRequested: false,
            closed: false,
        };
        const close = () => {
            if (entry.closed) return true;
            if (!entry.closable) {
                entry.closeRequested = true;
                return false;
            }
            entry.closed = true;
            this.entries.delete(entry);
            onClose();
            return true;
        };
        const setClosable = (value) => {
            entry.closable = value;
            onClosableChange(value);
            if (value && entry.closeRequested) close();
        };
        entry.close = close;
        this.entries.add(entry);
        return { close, setClosable };
    }

    /**
     * 请求关闭全部活动弹窗
     */
    closeAll() {
        for (const entry of [...this.entries]) entry.close();
    }
}
