import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolboxModuleRegistry } from '../modules/core/module-registry.js';

function createHarness(settings = { enabled: true, modules: { sample: { enabled: true } } }) {
    const instances = [];
    const definition = {
        id: 'sample',
        isEnabled: value => value.modules.sample.enabled,
        create() {
            const instance = {
                initializeCount: 0,
                enabledStates: [],
                async initialize() {
                    this.initializeCount++;
                },
                setEnabled(enabled) {
                    this.enabledStates.push(enabled);
                },
            };
            instances.push(instance);
            return instance;
        },
    };
    return {
        settings,
        instances,
        registry: new ToolboxModuleRegistry({ settings, definitions: [definition] }),
    };
}

test('disabled modules stay uninitialized until first enable', async () => {
    const harness = createHarness({ enabled: true, modules: { sample: { enabled: false } } });

    await harness.registry.applySettings();
    assert.equal(harness.instances.length, 0);

    harness.settings.modules.sample.enabled = true;
    await harness.registry.applySettings();
    assert.equal(harness.instances.length, 1);
    assert.equal(harness.instances[0].initializeCount, 1);
    assert.deepEqual(harness.instances[0].enabledStates, [true]);

    harness.settings.enabled = false;
    await harness.registry.applySettings();
    harness.settings.enabled = true;
    await harness.registry.applySettings();
    assert.equal(harness.instances.length, 1);
    assert.deepEqual(harness.instances[0].enabledStates, [true, false, true]);
});

test('failed module initialization can be retried', async () => {
    const settings = { enabled: true, modules: { sample: { enabled: true } } };
    let attempts = 0;
    const definition = {
        id: 'sample',
        isEnabled: value => value.modules.sample.enabled,
        create: () => ({
            async initialize() {
                attempts++;
                if (attempts === 1) throw new Error('temporary');
            },
            setEnabled() {},
        }),
    };
    const registry = new ToolboxModuleRegistry({ settings, definitions: [definition] });

    await assert.rejects(registry.applySettings(), /temporary/);
    await registry.applySettings();
    assert.equal(attempts, 2);
});

test('a module disabled during initialization finishes in the disabled state', async () => {
    const settings = { enabled: true, modules: { sample: { enabled: true } } };
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const enabledStates = [];
    const definition = {
        id: 'sample',
        isEnabled: value => value.modules.sample.enabled,
        create: () => ({
            initialize: () => gate,
            setEnabled: enabled => enabledStates.push(enabled),
        }),
    };
    const registry = new ToolboxModuleRegistry({ settings, definitions: [definition] });

    const enabling = registry.applySettings();
    settings.modules.sample.enabled = false;
    await registry.applySettings();
    release();
    await enabling;

    assert.deepEqual(enabledStates, [false]);
});
