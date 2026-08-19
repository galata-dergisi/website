import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchMagazinePages } from '../client/lib/reader-load.mjs';

function response(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function pendingUntilAborted(signal, onAbort = () => {}) {
  return new Promise((_resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(abortError());
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function createManualTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    fire(delay) {
      const entry = Array.from(pending.entries())
        .find(([, timer]) => timer.delay === delay);
      if (!entry) return false;
      const [id, timer] = entry;
      pending.delete(id);
      timer.callback();
      return true;
    },
    pendingCount: () => pending.size,
  };
}

async function flushOperations() {
  await Promise.resolve();
  await Promise.resolve();
}

test('loads magazine pages and defaults missing audio metadata', async () => {
  let request;
  const signal = new AbortController().signal;
  const result = await fetchMagazinePages(47, {
    signal,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({ success: true, pages: { 1: '<p>Kapak</p>' }});
    },
  });

  assert.equal(request.url, '/magazines/47/pages');
  assert.notEqual(request.options.signal, signal);
  assert.equal(request.options.signal.aborted, false);
  assert.deepEqual(result, {
    pages: { 1: '<p>Kapak</p>' },
    audioPlayers: {},
  });
});

test('rejects HTTP failures and malformed successful payloads', async () => {
  await assert.rejects(
    fetchMagazinePages(47, {
      fetchImpl: async () => response({}, { ok: false, status: 503 }),
    }),
    /status 503/,
  );
  await assert.rejects(
    fetchMagazinePages(47, {
      fetchImpl: async () => response({ success: true, pages: {}}),
    }),
    /response is invalid/,
  );
  await assert.rejects(
    fetchMagazinePages(47, {
      fetchImpl: async () => response({ success: false, message: 'Bulunamadı' }),
    }),
    /Bulunamadı/,
  );
});

test('propagates JSON failures and aborts from delayed requests', async () => {
  await assert.rejects(
    fetchMagazinePages(47, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('invalid JSON'); },
      }),
    }),
    /invalid JSON/,
  );

  const controller = new AbortController();
  const pending = fetchMagazinePages(47, {
    signal: controller.signal,
    fetchImpl: (url, { signal }) => pendingUntilAborted(signal),
  });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('bounds stalled reader headers and JSON bodies with a non-abort timeout', async () => {
  for (const phase of ['headers', 'body']) {
    const timers = createManualTimers();
    let upstreamAborts = 0;
    const pending = fetchMagazinePages(47, {
      timers,
      timeoutMs: 10_000,
      fetchImpl: (_url, { signal }) => {
        if (phase === 'headers') {
          return pendingUntilAborted(signal, () => { upstreamAborts += 1; });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => pendingUntilAborted(signal, () => { upstreamAborts += 1; }),
        });
      },
    });

    await flushOperations();
    assert.equal(timers.fire(10_000), true);
    await assert.rejects(pending, { name: 'NetworkTimeoutError' });
    assert.equal(upstreamAborts, 1, `${phase} timeout should abort its fetch`);
    assert.equal(timers.pendingCount(), 0);
  }
});

test('preserves caller cancellation and the first abort source', async () => {
  const callerTimers = createManualTimers();
  const callerController = new AbortController();
  const callerCancelled = fetchMagazinePages(47, {
    signal: callerController.signal,
    timers: callerTimers,
    fetchImpl: (_url, { signal }) => pendingUntilAborted(signal),
  });
  await flushOperations();
  callerController.abort();
  await assert.rejects(callerCancelled, { name: 'AbortError' });
  assert.equal(callerTimers.pendingCount(), 0);
  assert.equal(callerTimers.fire(10_000), false);

  const timeoutTimers = createManualTimers();
  const lateCaller = new AbortController();
  const timedOut = fetchMagazinePages(47, {
    signal: lateCaller.signal,
    timers: timeoutTimers,
    fetchImpl: (_url, { signal }) => pendingUntilAborted(signal),
  });
  await flushOperations();
  assert.equal(timeoutTimers.fire(10_000), true);
  lateCaller.abort();
  await assert.rejects(timedOut, { name: 'NetworkTimeoutError' });
  assert.equal(timeoutTimers.pendingCount(), 0);
});

test('cleans up deadlines after success and supports a fresh retry', async () => {
  const timers = createManualTimers();
  let requests = 0;
  const fetchImpl = (_url, { signal }) => {
    requests += 1;
    if (requests === 1) return pendingUntilAborted(signal);
    return Promise.resolve(response({ success: true, pages: { 1: '<p>Kapak</p>' }}));
  };

  const first = fetchMagazinePages(47, { fetchImpl, timers });
  await flushOperations();
  timers.fire(10_000);
  await assert.rejects(first, { name: 'NetworkTimeoutError' });
  assert.equal(timers.pendingCount(), 0);

  const retry = await fetchMagazinePages(47, { fetchImpl, timers });
  assert.deepEqual(retry.pages, { 1: '<p>Kapak</p>' });
  assert.equal(requests, 2);
  assert.equal(timers.pendingCount(), 0);
});
