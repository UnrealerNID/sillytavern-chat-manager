import assert from 'node:assert/strict';
import test from 'node:test';
import { bindGroupExpansion } from '../modules/chat-files/ui/group-expansion.js';

function classList() {
    const values = new Set();
    return {
        contains: value => values.has(value),
        toggle(value, enabled) {
            if (enabled) values.add(value);
            else values.delete(value);
        },
    };
}

test('group headers toggle while indicators and inner actions stay passive', () => {
    const listeners = new Map();
    const attributes = new Map();
    const header = {
        tabIndex: -1,
        title: '',
        addEventListener: (type, listener) => listeners.set(type, listener),
        setAttribute: (name, value) => attributes.set(name, value),
    };
    const icon = { classList: classList() };
    const indicator = { querySelector: () => icon };
    let toggled = 0;
    bindGroupExpansion(header, indicator, false, '聊天', () => { toggled++; });

    listeners.get('click')({ target: { closest: () => null } });
    listeners.get('click')({ target: { closest: () => ({ tagName: 'BUTTON' }) } });
    let prevented = false;
    listeners.get('keydown')({
        target: header,
        key: 'Enter',
        preventDefault: () => { prevented = true; },
    });

    assert.equal(toggled, 2);
    assert.equal(prevented, true);
    assert.equal(header.tabIndex, 0);
    assert.equal(attributes.get('aria-expanded'), 'false');
    assert.equal(header.title, '展开聊天');
    assert.equal(icon.classList.contains('fa-chevron-down'), true);
    assert.equal(icon.classList.contains('fa-chevron-up'), false);
});
