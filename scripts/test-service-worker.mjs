#!/usr/bin/env node

import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { finalizeServiceWorker } from './finalize-service-worker.mjs';
import {
  FakeCacheStorage,
  ServiceWorkerHarness,
  makeRequest,
} from './lib/service-worker-test-harness.mjs';
import shellAssets from './lib/shell-assets.js';

const { readerLeafPaths } = shellAssets;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const serviceWorkerFile = path.join(projectRoot, 'public', 'service-worker.js');
const origin = 'https://galatadergisi.org';

function createManualTimers() {
  let nextID = 1;
  const pending = new Map();

  return {
    setTimeout(callback, delay) {
      const id = nextID;
      nextID += 1;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    fire(delay) {
      const entry = Array.from(pending.entries()).find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `expected a pending ${delay}ms timer`);
      const [id, timer] = entry;
      pending.delete(id);
      timer.callback();
    },
    pendingCount() {
      return pending.size;
    },
    hasPending(delay) {
      return Array.from(pending.values()).some((timer) => timer.delay === delay);
    },
  };
}

async function waitForTimer(timers, delay) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (timers.hasPending(delay)) return;
    await Promise.resolve();
  }
  assert.fail(`service worker did not schedule a ${delay}ms timer`);
}

function pendingUntilAborted(onAbort) {
  return (request, { signal } = {}) => new Promise((_resolve, reject) => {
    assert.ok(signal, `timed fetch must have an abort signal: ${request.url}`);
    signal.addEventListener('abort', () => {
      onAbort();
      reject(signal.reason);
    }, { once: true });
  });
}

function responseWithStalledBody(onAbort, prefix = '{"pages":[') {
  return (request, { signal } = {}) => {
    assert.ok(signal, `timed fetch must have an abort signal: ${request.url}`);
    let bodyController;
    const response = new Response(new ReadableStream({
      start(controller) {
        bodyController = controller;
        controller.enqueue(new TextEncoder().encode(prefix));
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    signal.addEventListener('abort', () => {
      onAbort();
      bodyController.error(signal.reason);
    }, { once: true });
    return response;
  };
}

const firstBuild = finalizeServiceWorker();
const firstSource = fs.readFileSync(serviceWorkerFile, 'utf8');
const secondBuild = finalizeServiceWorker();
const secondSource = fs.readFileSync(serviceWorkerFile, 'utf8');

assert.equal(firstBuild.release, secondBuild.release, 'service worker release must be deterministic');
assert.equal(firstSource, secondSource, 'service worker output must be byte-identical');
assert.equal(
  firstBuild.precacheCount,
  firstBuild.assetManifest.groups.homepage.length,
  'only the declared homepage group must be installed',
);
assert.doesNotMatch(firstSource, /__GALATA_[A-Z_]+__/, 'build markers must be replaced');
assert.match(
  firstSource,
  new RegExp(`const RELEASE = '${firstBuild.release}'`),
  'generated worker must contain the asset-derived release',
);
assert.deepEqual(
  firstBuild.assetManifest,
  secondBuild.assetManifest,
  'shell asset manifest must be deterministic',
);
assert.deepEqual(
  Object.keys(firstBuild.assetManifest.groups).sort(),
  ['homepage', 'reader'],
  'release assets must use explicit phase groups',
);
assert.ok(
  Object.keys(firstBuild.assetManifest.assets).length > 100,
  'release manifest must cover generated AVIFs and the unified application shell',
);
assert.equal(
  Object.prototype.hasOwnProperty.call(firstBuild.assetManifest.assets, '/legacy-player.js'),
  false,
  'legacy player runtime must not remain in the current application shell',
);
assert.deepEqual(
  firstBuild.readerWarmURLs.map((url) => new URL(url, origin).pathname),
  readerLeafPaths,
  'reader warm group must contain only the declared leaf assets',
);
assert.equal(
  firstBuild.readerWarmURLs.some((url) => /\.(?:js|css)(?:\?|$)/.test(url)),
  false,
  'reader JavaScript and CSS must be part of the homepage bundle, not the warm group',
);

const storage = new FakeCacheStorage({
  origin,
  networkFetch: async (request) => {
    const url = new URL(request.url || request, origin);
    return new Response(`precache:${url.pathname}${url.search}`, { status: 200 });
  },
});
await storage.open('galatadergisi-cache-v22');
await storage.open('unrelated-application-cache');
const worker = new ServiceWorkerHarness(firstSource, {
  filename: serviceWorkerFile,
  origin,
  storage,
});
worker.assertListeners(['install', 'activate', 'message', 'fetch']);
await worker.install();
assert.equal(
  worker.skipWaitingCalled,
  false,
  'new service worker must wait for existing clients',
);

const { cacheStores } = storage;
const staticCacheName = Array.from(cacheStores.keys()).find(
  (name) => name === `galatadergisi-static-${firstBuild.release}`,
);
assert.ok(staticCacheName, 'install must create the release-scoped static cache');

const staticCache = cacheStores.get(staticCacheName);
assert.equal(
  (await staticCache.keys()).length,
  firstBuild.precacheCount,
  'install must populate only the homepage shell',
);
assert.deepEqual(
  (await staticCache.keys())
    .map(({ url }) => {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`;
    })
    .sort(),
  firstBuild.precacheURLs.slice().sort(),
  'install must cache only the exact current shell URLs',
);
for (const url of firstBuild.readerWarmURLs) {
  assert.equal(
    await staticCache.match(makeRequest(url)),
    undefined,
    `install must exclude deferred asset: ${url}`,
  );
}

let warmFetches = [];
let activeWarmFetches = 0;
let maximumWarmFetches = 0;
storage.setNetworkFetch(async (request) => {
  const url = new URL(request.url || request, origin);
  warmFetches.push(`${url.pathname}${url.search}`);
  activeWarmFetches += 1;
  maximumWarmFetches = Math.max(maximumWarmFetches, activeWarmFetches);
  await new Promise((resolve) => setTimeout(resolve, 2));
  activeWarmFetches -= 1;
  return new Response(`warm:${url.pathname}${url.search}`, { status: 200 });
});
await Promise.all([
  worker.dispatchMessage({ type: 'WARM_READER_CACHE', urls: ['/not-accepted.js'] }),
  worker.dispatchMessage({ type: 'WARM_READER_CACHE' }),
]);
assert.deepEqual(
  warmFetches.slice().sort(),
  firstBuild.readerWarmURLs.slice().sort(),
  'worker must ignore caller URLs and coalesce duplicate warm messages',
);
assert.equal(maximumWarmFetches, 2, 'reader warming must fetch at most two assets concurrently');
for (const url of firstBuild.readerWarmURLs) {
  assert.ok(await staticCache.match(makeRequest(url)), `reader warm must retain ${url}`);
}

warmFetches = [];
await worker.dispatchMessage({ type: 'NOT_A_READER_MESSAGE', urls: ['/not-accepted.js'] });
assert.deepEqual(warmFetches, [], 'unknown worker messages must be ignored');
await worker.dispatchMessage({ type: 'WARM_READER_CACHE' });
assert.deepEqual(warmFetches, [], 'reader warm must skip every existing cache entry');

const [failedReaderURL, laterReaderURL] = firstBuild.readerWarmURLs;
await staticCache.delete(makeRequest(failedReaderURL));
await staticCache.delete(makeRequest(laterReaderURL));
storage.setNetworkFetch(async (request) => {
  const url = new URL(request.url || request, origin);
  const value = `${url.pathname}${url.search}`;
  warmFetches.push(value);
  if (value === failedReaderURL) throw new Error('partial reader warm failure');
  return new Response(`warm:${value}`, { status: 200 });
});
warmFetches = [];
await worker.dispatchMessage({ type: 'WARM_READER_CACHE' });
assert.deepEqual(
  warmFetches.slice().sort(),
  [failedReaderURL, laterReaderURL].sort(),
  'partial warm must continue after an individual failure',
);
assert.equal(await staticCache.match(makeRequest(failedReaderURL)), undefined);
assert.ok(await staticCache.match(makeRequest(laterReaderURL)));
storage.setNetworkFetch(async (request) => {
  const url = new URL(request.url || request, origin);
  warmFetches.push(`${url.pathname}${url.search}`);
  return new Response('reader retry', { status: 200 });
});
warmFetches = [];
await worker.dispatchMessage({ type: 'WARM_READER_CACHE' });
assert.deepEqual(warmFetches, [failedReaderURL], 'next load must retry the failed reader asset');

const earlyReaderURL = firstBuild.readerWarmURLs[0];
await staticCache.delete(makeRequest(earlyReaderURL));
let earlyReaderFetches = 0;
let releaseEarlyReaderFetch;
let markEarlyReaderFetchStarted;
const earlyReaderFetchStarted = new Promise((resolve) => {
  markEarlyReaderFetchStarted = resolve;
});
const earlyReaderFetchGate = new Promise((resolve) => {
  releaseEarlyReaderFetch = resolve;
});
storage.setNetworkFetch(async () => {
  earlyReaderFetches += 1;
  markEarlyReaderFetchStarted();
  await earlyReaderFetchGate;
  return new Response('early reader', { status: 200 });
});
const concurrentWarm = worker.dispatchMessage({ type: 'WARM_READER_CACHE' });
await earlyReaderFetchStarted;
const concurrentReaderResponse = worker.dispatchFetch(makeRequest(earlyReaderURL)).response();
releaseEarlyReaderFetch();
assert.equal(await (await concurrentReaderResponse).text(), 'early reader');
await concurrentWarm;
const cachedReaderResponse = await worker.dispatchFetch(makeRequest(earlyReaderURL)).response();
assert.equal(await cachedReaderResponse.text(), 'early reader');
assert.equal(
  earlyReaderFetches,
  1,
  'reader warming and concurrent reader use must share one cache-first network request',
);

await worker.activate();
assert.ok(worker.clientsClaimed, 'activated service worker must claim existing clients');
assert.ok(
  storage.deletedCacheNames.includes('galatadergisi-cache-v22'),
  'obsolete Galata caches must be removed',
);
assert.ok(
  cacheStores.has('unrelated-application-cache'),
  'activation must preserve caches owned by other applications',
);

for (const request of [
  makeRequest('/', { method: 'POST' }),
  makeRequest('/magazines/sayi6/audio/1.mp3'),
  makeRequest('/images/sayi47/thumbnail.jpg'),
  makeRequest('/images/sayi47/front.jpg'),
  makeRequest('/healthz'),
  makeRequest('/bundle.js', { range: 'bytes=0-99' }),
  makeRequest('https://www.googletagmanager.com/gtag/js?id=test'),
]) {
  const event = worker.dispatchFetch(request);
  assert.equal(event.wasIntercepted(), false, `must bypass service worker: ${request.url}`);
}

let fetchCount = 0;
storage.setNetworkFetch(async (request) => {
  fetchCount += 1;
  return new Response(`network:${request.url}`, { status: 200 });
});

const shellURL = firstBuild.assetManifest.assets['/bundle.js'].url;
const shellRequest = makeRequest(shellURL);
const shellEvent = worker.dispatchFetch(shellRequest);
const shellResponse = await shellEvent.response();
assert.equal(await shellResponse.text(), `precache:${shellURL}`);
assert.equal(fetchCount, 0, 'pre-cached application shell must not hit the network');

const placeholderURL = firstBuild.assetManifest
  .assets['/images/carousel-thumbnail-placeholders.webp'].url;
const placeholderEvent = worker.dispatchFetch(makeRequest(placeholderURL));
assert.equal(
  await (await placeholderEvent.response()).text(),
  `precache:${placeholderURL}`,
  'carousel placeholder sprite must come from the static shell cache',
);
assert.equal(fetchCount, 0, 'pre-cached placeholder sprite must not hit the network');

const magazinesRequest = makeRequest('/magazines');
storage.setNetworkFetch(async () => new Response('{"success":true}', {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
}));
const onlineMagazinesEvent = worker.dispatchFetch(magazinesRequest);
assert.equal(await (await onlineMagazinesEvent.response()).text(), '{"success":true}');

storage.setNetworkFetch(async () => {
  throw new Error('offline');
});
const offlineMagazinesEvent = worker.dispatchFetch(magazinesRequest);
assert.equal(
  await (await offlineMagazinesEvent.response()).text(),
  '{"success":true}',
  'network-first JSON must fall back to the runtime cache',
);

storage.setNetworkFetch(async () => new Response('server error', { status: 503 }));
const failedMagazinesEvent = worker.dispatchFetch(magazinesRequest);
assert.equal(
  await (await failedMagazinesEvent.response()).text(),
  '{"success":true}',
  'a current 5xx must fall back to the runtime cache',
);

const seoRequest = makeRequest('/magazines/47/seo');
storage.setNetworkFetch(async () => new Response('{"success":true,"issue":47}', {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
}));
const onlineSeoEvent = worker.dispatchFetch(seoRequest);
assert.equal(
  await (await onlineSeoEvent.response()).text(),
  '{"success":true,"issue":47}',
);

storage.setNetworkFetch(async () => {
  throw new Error('offline');
});
const offlineSeoEvent = worker.dispatchFetch(seoRequest);
assert.equal(
  await (await offlineSeoEvent.response()).text(),
  '{"success":true,"issue":47}',
  'reader SEO metadata must fall back to the runtime cache',
);

storage.setNetworkFetch(async () => new Response('not found', { status: 404 }));
const removedMagazinesEvent = worker.dispatchFetch(magazinesRequest);
assert.equal(
  (await removedMagazinesEvent.response()).status,
  404,
  'a current 404 must not revive a stale cached response',
);
assert.equal(
  await cacheStores.get(`galatadergisi-runtime-${firstBuild.release}`).match(magazinesRequest),
  undefined,
  'a removed route must also be purged from the runtime cache',
);

storage.setNetworkFetch(async () => {
  throw new Error('offline');
});
const navigationEvent = worker.dispatchFetch(
  makeRequest('/dergiler/sayi47/10', { mode: 'navigate' }),
);
const navigationResponse = await navigationEvent.response();
assert.equal(navigationResponse.status, 503);
assert.match(await navigationResponse.text(), /Bağlantı kurulamadı/);

const timeoutStorage = new FakeCacheStorage({ origin });
const timeoutTimers = createManualTimers();
const timeoutWorker = new ServiceWorkerHarness(firstSource, {
  filename: serviceWorkerFile,
  origin,
  storage: timeoutStorage,
  timers: timeoutTimers,
});
const timeoutRuntimeCacheName = `galatadergisi-runtime-${firstBuild.release}`;
const cachedPagesRequest = makeRequest('/magazines/47/pages');
await timeoutStorage.seed(
  timeoutRuntimeCacheName,
  '/magazines/47/pages',
  new Response('{"pages":["cached"]}', { status: 200 }),
);

let upstreamAborts = 0;
timeoutStorage.setNetworkFetch(pendingUntilAborted(() => {
  upstreamAborts += 1;
}));
const cachedTimeoutPromise = timeoutWorker.dispatchFetch(cachedPagesRequest).response();
await waitForTimer(timeoutTimers, 3_000);
timeoutTimers.fire(3_000);
assert.equal(
  await (await cachedTimeoutPromise).text(),
  '{"pages":["cached"]}',
  'a cached reader request must fall back after three seconds',
);
assert.equal(upstreamAborts, 1, 'a cached timeout must abort the upstream fetch');
assert.equal(timeoutTimers.pendingCount(), 0, 'a cached timeout must clean up its timer');

const uncachedPagesRequest = makeRequest('/magazines/46/pages');
const uncachedTimeoutPromise = timeoutWorker.dispatchFetch(uncachedPagesRequest).response();
await waitForTimer(timeoutTimers, 10_000);
timeoutTimers.fire(10_000);
await assert.rejects(
  uncachedTimeoutPromise,
  (error) => error.name === 'NetworkTimeoutError' && /timed out/.test(error.message),
  'an uncached reader timeout must remain a non-abort failure',
);
assert.equal(upstreamAborts, 2, 'an uncached timeout must abort the upstream fetch');
assert.equal(timeoutTimers.pendingCount(), 0, 'an uncached timeout must clean up its timer');

const navigationTimeoutPromise = timeoutWorker.dispatchFetch(
  makeRequest('/dergiler/sayi46/10', { mode: 'navigate' }),
).response();
await waitForTimer(timeoutTimers, 10_000);
timeoutTimers.fire(10_000);
const navigationTimeoutResponse = await navigationTimeoutPromise;
assert.equal(navigationTimeoutResponse.status, 503);
assert.match(await navigationTimeoutResponse.text(), /Bağlantı kurulamadı/);
assert.equal(upstreamAborts, 3, 'a navigation timeout must abort the upstream fetch');
assert.equal(timeoutTimers.pendingCount(), 0, 'a navigation timeout must clean up its timer');

const callerController = new AbortController();
const cancelledPagesRequest = makeRequest('/magazines/45/pages', {
  signal: callerController.signal,
});
await timeoutStorage.seed(
  timeoutRuntimeCacheName,
  '/magazines/45/pages',
  new Response('{"pages":["stale"]}', { status: 200 }),
);
const cancelledPromise = timeoutWorker.dispatchFetch(cancelledPagesRequest).response();
await waitForTimer(timeoutTimers, 3_000);
callerController.abort();
await assert.rejects(
  cancelledPromise,
  (error) => error.name === 'AbortError',
  'caller cancellation must not fall back to cached reader content',
);
assert.equal(timeoutTimers.pendingCount(), 0, 'caller cancellation must clean up its timer');

timeoutStorage.setNetworkFetch(async () => new Response('{"pages":["fresh"]}', {
  status: 200,
}));
const fastPagesResponse = await timeoutWorker.dispatchFetch(cachedPagesRequest).response();
assert.equal(await fastPagesResponse.text(), '{"pages":["fresh"]}');
assert.equal(
  await (await timeoutStorage.cacheStores
    .get(timeoutRuntimeCacheName)
    .match(cachedPagesRequest)).text(),
  '{"pages":["fresh"]}',
  'a fast reader response must refresh the runtime cache',
);
assert.equal(timeoutTimers.pendingCount(), 0, 'a fast response must clean up its timer');

const bodyTimeoutStorage = new FakeCacheStorage({ origin });
const bodyTimeoutTimers = createManualTimers();
const bodyTimeoutWorker = new ServiceWorkerHarness(firstSource, {
  filename: serviceWorkerFile,
  origin,
  storage: bodyTimeoutStorage,
  timers: bodyTimeoutTimers,
});
const bodyTimeoutRuntimeCacheName = `galatadergisi-runtime-${firstBuild.release}`;
const cachedBodyRequest = makeRequest('/magazines/44/pages');
await bodyTimeoutStorage.seed(
  bodyTimeoutRuntimeCacheName,
  '/magazines/44/pages',
  new Response('{"pages":["cached body"]}', { status: 200 }),
);

let bodyAborts = 0;
bodyTimeoutStorage.setNetworkFetch(responseWithStalledBody(() => {
  bodyAborts += 1;
}));
const cachedBodyTimeoutPromise = bodyTimeoutWorker.dispatchFetch(cachedBodyRequest).response();
await waitForTimer(bodyTimeoutTimers, 3_000);
bodyTimeoutTimers.fire(3_000);
assert.equal(
  await (await cachedBodyTimeoutPromise).text(),
  '{"pages":["cached body"]}',
  'a cached reader request must fall back when its response body stalls',
);
assert.equal(bodyAborts, 1, 'a cached body timeout must abort the upstream response');
assert.equal(bodyTimeoutTimers.pendingCount(), 0, 'a cached body timeout must clean up its timer');

const uncachedBodyRequest = makeRequest('/magazines/43/pages');
const uncachedBodyTimeoutPromise = bodyTimeoutWorker
  .dispatchFetch(uncachedBodyRequest)
  .response();
await waitForTimer(bodyTimeoutTimers, 10_000);
bodyTimeoutTimers.fire(10_000);
await assert.rejects(
  uncachedBodyTimeoutPromise,
  (error) => error.name === 'NetworkTimeoutError' && /timed out/.test(error.message),
  'an uncached stalled response body must remain a non-abort failure',
);
assert.equal(bodyAborts, 2, 'an uncached body timeout must abort the upstream response');
assert.equal(
  bodyTimeoutTimers.pendingCount(),
  0,
  'an uncached body timeout must clean up its timer',
);

const navigationBodyTimeoutPromise = bodyTimeoutWorker.dispatchFetch(
  makeRequest('/dergiler/sayi43/10', { mode: 'navigate' }),
).response();
await waitForTimer(bodyTimeoutTimers, 10_000);
bodyTimeoutTimers.fire(10_000);
const navigationBodyTimeoutResponse = await navigationBodyTimeoutPromise;
assert.equal(navigationBodyTimeoutResponse.status, 503);
assert.match(await navigationBodyTimeoutResponse.text(), /Bağlantı kurulamadı/);
assert.equal(bodyAborts, 3, 'a navigation body timeout must abort the upstream response');
assert.equal(
  bodyTimeoutTimers.pendingCount(),
  0,
  'a navigation body timeout must clean up its timer',
);

const bodyCallerController = new AbortController();
const cancelledBodyRequest = makeRequest('/magazines/42/pages', {
  signal: bodyCallerController.signal,
});
await bodyTimeoutStorage.seed(
  bodyTimeoutRuntimeCacheName,
  '/magazines/42/pages',
  new Response('{"pages":["stale body"]}', { status: 200 }),
);
const cancelledBodyPromise = bodyTimeoutWorker.dispatchFetch(cancelledBodyRequest).response();
await waitForTimer(bodyTimeoutTimers, 3_000);
bodyCallerController.abort();
await assert.rejects(
  cancelledBodyPromise,
  (error) => error.name === 'AbortError',
  'caller cancellation during a response body must not use cached content',
);
assert.equal(bodyAborts, 4, 'caller cancellation must abort the upstream response body');
assert.equal(
  bodyTimeoutTimers.pendingCount(),
  0,
  'caller cancellation during a response body must clean up its timer',
);

bodyTimeoutStorage.setNetworkFetch(async () => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('{"pages":["fresh streamed body"]}'));
    controller.close();
  },
}), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
}));
const streamedBodyResponse = await bodyTimeoutWorker.dispatchFetch(cachedBodyRequest).response();
assert.equal(await streamedBodyResponse.text(), '{"pages":["fresh streamed body"]}');
assert.equal(
  await (await bodyTimeoutStorage.cacheStores
    .get(bodyTimeoutRuntimeCacheName)
    .match(cachedBodyRequest)).text(),
  '{"pages":["fresh streamed body"]}',
  'a completed streamed response must refresh the runtime cache',
);
assert.equal(bodyTimeoutTimers.pendingCount(), 0, 'a completed body must clean up its timer');

const unrelatedRuntimeRequest = makeRequest('/generated-metadata-timeout-check.json');
await timeoutWorker.dispatchFetch(unrelatedRuntimeRequest).response();
assert.equal(
  timeoutTimers.pendingCount(),
  0,
  'unrelated runtime requests must remain outside the adaptive deadline policy',
);

storage.setNetworkFetch(
  async (request) => new Response(`metadata:${request.url}`, { status: 200 }),
);
for (let index = 0; index < 70; index += 1) {
  const event = worker.dispatchFetch(makeRequest(`/generated-metadata-${index}.json`));
  await event.response();
}

const runtimeCacheName = `galatadergisi-runtime-${firstBuild.release}`;
const runtimeCache = cacheStores.get(runtimeCacheName);
assert.ok(runtimeCache, 'runtime cache must be release-scoped');
assert.ok(
  (await runtimeCache.keys()).length <= 64,
  'runtime cache must remain bounded',
);

const audioRequest = makeRequest('/magazines/sayi36/audio/1.mp3');
await runtimeCache.put(audioRequest, new Response('full audio', { status: 200 }));
let forwardedRange = null;
storage.setNetworkFetch(async (request) => {
  forwardedRange = request.headers.get('Range');
  return new Response('partial audio', {
    status: 206,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Range': 'bytes 40-79/100',
      'Content-Length': '40',
    },
  });
});
const audioRangeResponse = await worker.handleRequest(
  makeRequest('/magazines/sayi36/audio/1.mp3', { range: 'bytes=40-79' }),
);
assert.equal(audioRangeResponse.status, 206);
assert.equal(forwardedRange, 'bytes=40-79');
assert.equal(await audioRangeResponse.text(), 'partial audio');
assert.equal(
  await (await runtimeCache.match(audioRequest)).text(),
  'full audio',
  'range pass-through must neither read nor replace the cached full response',
);

await staticCache.delete(shellRequest);
storage.setNetworkFetch(async () => new Response('partial', {
  status: 206,
  headers: { 'Content-Range': 'bytes 0-6/100' },
}));
const partialShellEvent = worker.dispatchFetch(shellRequest);
assert.equal((await partialShellEvent.response()).status, 206);
assert.equal(
  await staticCache.match(shellRequest),
  undefined,
  'partial responses must never be written to Cache Storage',
);

process.stdout.write(
  `Service worker ${firstBuild.release} passed lifecycle, routing, and cache-safety tests.\n`,
);
