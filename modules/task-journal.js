const DB_NAME = 'sillytavern-chat-manager';
const STORE_NAME = 'tasks';
const DB_VERSION = 1;

export class TaskJournal {
    #dbPromise;

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

    /** @param {IDBTransactionMode} mode Transaction mode */
    async #store(mode) {
        const db = await this.#dbPromise;
        return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
    }

    /** @param {object} task Task */
    async put(task) {
        const store = await this.#store('readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put(task);
            request.onsuccess = () => resolve(task);
            request.onerror = () => reject(request.error);
        });
    }

    async list() {
        const store = await this.#store('readonly');
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result ?? []);
            request.onerror = () => reject(request.error);
        });
    }

    /** @param {string} id Task ID */
    async remove(id) {
        const store = await this.#store('readwrite');
        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}
