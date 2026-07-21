import assert from 'node:assert/strict';
import test from 'node:test';
import {
    removeModalDialog,
    showModalDialog,
    waitForDom,
} from '../modules/platform/dom.js';

test('DOM waiting resolves after a later mutation and disconnects its observer', async () => {
    const OriginalObserver = globalThis.MutationObserver;
    let inspect;
    let disconnected = false;
    globalThis.MutationObserver = class {
        constructor(callback) {
            inspect = callback;
        }

        observe() {}

        disconnect() {
            disconnected = true;
        }
    };
    try {
        let target = null;
        const waiting = waitForDom(() => target, { root: {}, timeout: 1000 });
        target = { id: 'late-target' };
        inspect();
        assert.equal(await waiting, target);
        assert.equal(disconnected, true);
    } finally {
        globalThis.MutationObserver = OriginalObserver;
    }
});

test('DOM waiting can be cancelled without waiting for its timeout', async () => {
    const OriginalObserver = globalThis.MutationObserver;
    globalThis.MutationObserver = class {
        observe() {}
        disconnect() {}
    };
    try {
        const controller = new AbortController();
        const waiting = waitForDom(() => null, {
            root: {},
            signal: controller.signal,
            timeout: 1000,
        });
        controller.abort();
        await assert.rejects(waiting, error => error.name === 'AbortError');
    } finally {
        globalThis.MutationObserver = OriginalObserver;
    }
});

test('modal dialogs share one top-layer open and close primitive', () => {
    const originalDocument = globalThis.document;
    let cancel;
    let cancelled = false;
    let prevented = false;
    const dialog = {
        open: false,
        addEventListener(type, listener) {
            if (type === 'cancel') cancel = listener;
        },
        showModal() {
            this.open = true;
        },
        close() {
            this.open = false;
        },
        remove() {
            this.removed = true;
        },
    };
    globalThis.document = {
        body: {
            append(node) {
                assert.equal(node, dialog);
            },
        },
    };
    try {
        showModalDialog(dialog, () => { cancelled = true; });
        assert.equal(dialog.open, true);
        cancel({ preventDefault: () => { prevented = true; } });
        assert.equal(prevented, true);
        assert.equal(cancelled, true);
        removeModalDialog(dialog);
        assert.equal(dialog.open, false);
        assert.equal(dialog.removed, true);
    } finally {
        globalThis.document = originalDocument;
    }
});
