import { getImageSizeFromDataURL } from '/scripts/utils.js';

import {
    createChatSnapshot,
    createTextSnapshot,
} from '../prompt-common/snapshot.js';
import { countPromptMessageTokens } from '../prompt-common/token-counter.js';

/**
 * 捕获真正进入正式请求的最终提示词
 */
export class PromptViewerCapture {
    constructor({ getContext, store }) {
        this.getContext = getContext;
        this.store = store;
        this.enabled = false;
        this.revision = 0;
    }

    setEnabled(enabled) {
        this.enabled = enabled;
    }

    async captureChat(payload) {
        if (!this.enabled || !Array.isArray(payload?.messages)) return;
        const revision = ++this.revision;
        const context = this.getContext();
        const snapshot = await createChatSnapshot({
            chat: payload.messages,
            countMessageTokens: message => countPromptMessageTokens(
                message,
                text => context.getTokenCountAsync(text),
                getImageSizeFromDataURL,
            ),
        });
        if (revision === this.revision) this.store.setSnapshot(snapshot);
    }

    async captureText(payload, dryRun) {
        if (!this.enabled || dryRun === true || typeof payload?.prompt !== 'string') return;
        const revision = ++this.revision;
        const context = this.getContext();
        const snapshot = await createTextSnapshot({
            prompt: payload.prompt,
            countTokens: text => context.getTokenCountAsync(text),
        });
        if (revision === this.revision) this.store.setSnapshot(snapshot);
    }
}
