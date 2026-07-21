import assert from 'node:assert/strict';
import test from 'node:test';
import { DialogRegistry } from '../modules/chat-files/ui/dialog-registry.js';

test('dialog registry defers closing a protected operation until it becomes closable', () => {
    const registry = new DialogRegistry();
    const events = [];
    const dialog = registry.register(
        () => events.push('closed'),
        value => events.push(value ? 'enabled' : 'disabled'),
    );

    dialog.setClosable(false);
    registry.closeAll();
    assert.deepEqual(events, ['disabled']);

    dialog.setClosable(true);
    assert.deepEqual(events, ['disabled', 'enabled', 'closed']);
    assert.equal(dialog.close(), true);
    assert.deepEqual(events, ['disabled', 'enabled', 'closed']);
});
