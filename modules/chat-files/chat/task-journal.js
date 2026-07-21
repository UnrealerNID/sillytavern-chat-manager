const DB_NAME = 'sillytavern-toolbox';
const STORE_NAME = 'tasks';
const DB_VERSION = 1;

export class TaskJournal {
    #dbPromise;

    /**
     * 打开分卷任务数据库，并在首次使用时创建对象存储
     */
    constructor() {
        this.#dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                    request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 打开任务存储事务
     * @param {IDBTransactionMode} mode 事务模式
     * @returns {Promise<IDBObjectStore>} 对象存储
     */
    async #store(mode) {
        const db = await this.#dbPromise;
        return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
    }

    /**
     * 保存分卷任务
     * @param {object} task 分卷任务
     */
    async put(task) {
        const store = await this.#store('readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put(task);
            request.onsuccess = () => resolve(task);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 读取全部待恢复的分卷任务
     * @returns {Promise<object[]>} 分卷任务列表
     */
    async list() {
        const store = await this.#store('readonly');
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result ?? []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 删除分卷任务
     * @param {string} id 任务 ID
     */
    async remove(id) {
        const store = await this.#store('readwrite');
        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}
