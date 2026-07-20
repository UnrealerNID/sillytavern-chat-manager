import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRanges, canonicalJson, isNewerVersion, stripJsonl } from '../modules/utils.js';

test('buildRanges keeps inclusive floors and the remainder', () => {
    assert.deepEqual(buildRanges(100, 349, 100), [
        { start: 100, end: 199, count: 100 },
        { start: 200, end: 299, count: 100 },
        { start: 300, end: 349, count: 50 },
    ]);
});

test('buildRanges creates one inclusive range', () => {
    assert.deepEqual(buildRanges(3, 7), [{ start: 3, end: 7, count: 5 }]);
});

test('canonicalJson ignores object key insertion order', () => {
    assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
});

test('stripJsonl removes only a trailing extension', () => {
    assert.equal(stripJsonl('聊天.jsonl'), '聊天');
    assert.equal(stripJsonl('聊天.jsonl.copy'), '聊天.jsonl.copy');
});

test('isNewerVersion only accepts a higher remote release', () => {
    assert.equal(isNewerVersion('0.1.13', '0.1.12'), true);
    assert.equal(isNewerVersion('0.1.12', '0.1.12'), false);
    assert.equal(isNewerVersion('0.1.10', '0.1.12'), false);
    assert.equal(isNewerVersion('invalid', '0.1.12'), false);
});
