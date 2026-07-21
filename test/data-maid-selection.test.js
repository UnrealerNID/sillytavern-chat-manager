import assert from 'node:assert/strict';
import test from 'node:test';
import { DataMaidSelection } from '../modules/chat-files/backups/data-maid-selection.js';

function createClassList() {
    const values = new Set();
    return {
        add: value => values.add(value),
        remove: value => values.delete(value),
        contains: value => values.has(value),
        toggle(value, force) {
            const enabled = force ?? !values.has(value);
            if (enabled) values.add(value);
            else values.delete(value);
            return enabled;
        },
    };
}

function createControl() {
    const listeners = new Map();
    return {
        classList: createClassList(),
        disabled: false,
        textContent: '',
        title: '',
        addEventListener: (type, listener) => listeners.set(type, listener),
        setAttribute() {},
        dispatch: type => listeners.get(type)?.(),
    };
}

test('backup selection only operates on visible items and resets with the panel session', () => {
    const first = {
        record: { hash: 'first' },
        element: { isConnected: true, classList: createClassList() },
        checkbox: createControl(),
    };
    const second = {
        record: { hash: 'second' },
        element: { isConnected: true, classList: createClassList() },
        checkbox: createControl(),
    };
    second.element.classList.add('cm-hidden');
    const items = new Map([['first', first], ['second', second]]);
    const deleted = [];
    const controls = {
        category: createControl(),
        selectionToolbar: createControl(),
        batchStart: createControl(),
        selectAll: createControl(),
        clearSelection: createControl(),
        deleteSelected: createControl(),
        selectedCount: createControl(),
    };
    const selection = new DataMaidSelection({
        getItems: () => items,
        isBusy: () => false,
        onDelete: selected => deleted.push(selected),
    });
    selection.bindItem(first);
    selection.bindItem(second);
    selection.mount(controls);

    controls.batchStart.dispatch('click');
    controls.selectAll.dispatch('click');
    assert.equal(first.checkbox.checked, true);
    assert.notEqual(second.checkbox.checked, true);
    assert.equal(controls.selectedCount.textContent, '已选 1 项');

    controls.deleteSelected.dispatch('click');
    assert.deepEqual(deleted[0], [first]);

    selection.reset();
    assert.equal(first.checkbox.checked, false);
    assert.equal(first.element.classList.contains('cm-selected'), false);
});
