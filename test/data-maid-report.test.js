import test from 'node:test';
import assert from 'node:assert/strict';

import { captureNextDataMaidReport } from '../modules/chat-files/backups/data-maid-report.js';

test('data maid report capture only observes the request started by the current action', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async input => {
        requests.push(input);
        return new Response(JSON.stringify({ token: String(input), report: {} }));
    };

    try {
        const baseFetch = globalThis.fetch;
        const capture = captureNextDataMaidReport();
        const nativeRequest = globalThis.fetch('/api/data-maid/report');
        assert.equal(globalThis.fetch, baseFetch);
        await globalThis.fetch('/api/data-maid/report?unrelated');

        assert.equal((await capture.promise).token, '/api/data-maid/report');
        assert.deepEqual(requests, [
            '/api/data-maid/report',
            '/api/data-maid/report?unrelated',
        ]);
        await nativeRequest;
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('data maid report capture survives an asynchronous native scan boundary', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async input => new Response(JSON.stringify({
        token: String(input),
        report: {},
    }));

    try {
        const baseFetch = globalThis.fetch;
        const capture = captureNextDataMaidReport(1_000);
        await Promise.resolve();
        await Promise.resolve();
        globalThis.fetch('/api/data-maid/report');

        assert.equal((await capture.promise).token, '/api/data-maid/report');
        assert.equal(globalThis.fetch, baseFetch);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('data maid report capture can be cancelled with its scan session', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response();

    try {
        const baseFetch = globalThis.fetch;
        const capture = captureNextDataMaidReport(1_000);
        capture.cancel();

        await assert.rejects(capture.promise, error => error.name === 'AbortError');
        assert.equal(globalThis.fetch, baseFetch);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
