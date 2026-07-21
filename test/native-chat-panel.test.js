import test from 'node:test';
import assert from 'node:assert/strict';

import { NativeChatPanel } from '../modules/chat-files/ui/native-chat-panel.js';

test('setEnabled removes native actions without reloading the page', () => {
    const action = { removeCalled: false, remove() { this.removeCalled = true; } };
    const wrapper = { dataset: { chatManagerEnhanced: 'true' } };
    const container = {
        removeEventListener() {},
        querySelectorAll(selector) {
            if (selector === '[data-chat-manager-action]') return [action];
            if (selector === '[data-chat-manager-enhanced]') return [wrapper];
            return [];
        },
    };
    const panel = new NativeChatPanel({ getContext: () => ({}), ui: {}, isGenerating: () => false });
    panel.container = container;

    panel.setEnabled(false);

    assert.equal(panel.enabled, false);
    assert.equal(action.removeCalled, true);
    assert.equal(wrapper.dataset.chatManagerEnhanced, undefined);
});
