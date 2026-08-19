// Copyright 2020-2026 Mehmet Baker
//
// This file is part of galata-dergisi and is licensed under GPL-3.0-or-later.

/* eslint no-restricted-globals: 1 */

const CACHE_PREFIX = 'galatadergisi-';
const RELEASE = '__GALATA_ASSET_VERSION__';
const STATIC_CACHE = `${CACHE_PREFIX}static-${RELEASE}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-${RELEASE}`;
const ACTIVE_CACHES = new Set([STATIC_CACHE, RUNTIME_CACHE]);
const MAX_RUNTIME_ENTRIES = 64;
const READER_WARM_CONCURRENCY = 2;
const CACHED_NETWORK_TIMEOUT_MS = 3_000;
const UNCACHED_NETWORK_TIMEOUT_MS = 10_000;
const staticFetches = new Map();
let readerWarmPromise = null;

// The build replaces these fixed lists. Message senders can request the reader
// group, but cannot choose which URLs the worker fetches.
const PRECACHE_URLS = /* __GALATA_PRECACHE_URLS__ */ [];
const READER_WARM_URLS = /* __GALATA_READER_WARM_URLS__ */ [];
const CONTRIBUTION_URLS = /* __GALATA_CONTRIBUTION_URLS__ */ [];
const STATIC_PATHS = new Set(
  [...PRECACHE_URLS, ...READER_WARM_URLS, ...CONTRIBUTION_URLS]
    .map((url) => new URL(url, self.location.origin).pathname),
);

const networkOnlyPaths = [
  /^\/healthz$/,
  /^\/audio\//,
  /^\/uploads\//,
  /^\/magazines\/sayi\d+\/audio\//,
  /^\/images\/sayi\d+\//,
];

const networkFirstPaths = [
  /^\/magazines\/?$/,
  /^\/magazines\/\d+\/(?:pages|seo)\/?$/,
];

const cacheableCrossOriginURLs = [
  /^https:\/\/cdnjs\.cloudflare\.com\//,
];

function isCacheableResponse(response) {
  if (!response || response.status === 206) return false;
  return response.status === 200 || response.type === 'opaque';
}

async function trimCache(cache, maximumEntries) {
  const requests = await cache.keys();
  const excess = requests.length - maximumEntries;
  if (excess <= 0) return;
  await Promise.all(requests.slice(0, excess).map((request) => cache.delete(request)));
}

async function storeResponse(cacheName, request, response, maximumEntries = null) {
  if (!isCacheableResponse(response)) return false;
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
    if (maximumEntries !== null) await trimCache(cache, maximumEntries);
    return true;
  } catch (error) {
    console.warn('Service worker cache write failed.', error);
    return false;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cachedResponse = await cache.match(request);
  if (cachedResponse) return cachedResponse;

  const requestKey = request.url;
  let pendingFetch = staticFetches.get(requestKey);
  if (!pendingFetch) {
    pendingFetch = (async () => {
      const networkResponse = await fetch(request);
      await storeResponse(STATIC_CACHE, request, networkResponse);
      return networkResponse;
    })().finally(() => {
      staticFetches.delete(requestKey);
    });
    staticFetches.set(requestKey, pendingFetch);
  }
  return (await pendingFetch).clone();
}

function networkTimeoutError() {
  const error = new Error('Network request timed out.');
  error.name = 'NetworkTimeoutError';
  return error;
}

async function fetchWithTimeout(request, timeout) {
  const controller = new AbortController();
  const callerSignal = request.signal;
  let timedOut = false;

  const forwardCallerAbort = () => controller.abort(callerSignal.reason);
  if (callerSignal?.aborted) {
    forwardCallerAbort();
  } else {
    callerSignal?.addEventListener('abort', forwardCallerAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);

  try {
    const response = await fetch(request, { signal: controller.signal });
    // Fetch resolves when response headers arrive. Drain a clone before
    // clearing the deadline so a stalled body cannot block the cache write or
    // the client response indefinitely.
    await response.clone().arrayBuffer();
    return response;
  } catch (error) {
    if (timedOut) throw networkTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardCallerAbort);
  }
}

async function networkFirst(request, fallbackResponse = null, {
  adaptiveTimeout = false,
} = {}) {
  const cache = await caches.open(RUNTIME_CACHE);
  const initialCachedResponse = adaptiveTimeout ? await cache.match(request) : null;
  try {
    const timeout = initialCachedResponse
      ? CACHED_NETWORK_TIMEOUT_MS
      : UNCACHED_NETWORK_TIMEOUT_MS;
    const networkResponse = adaptiveTimeout
      ? await fetchWithTimeout(request, timeout)
      : await fetch(request);
    if (isCacheableResponse(networkResponse)) {
      await storeResponse(RUNTIME_CACHE, request, networkResponse, MAX_RUNTIME_ENTRIES);
      return networkResponse;
    }
    if ([401, 403, 404, 410].includes(networkResponse.status)) {
      await cache.delete(request);
      return networkResponse;
    }
    if (networkResponse.status >= 500) {
      const cachedResponse = initialCachedResponse || await cache.match(request);
      return cachedResponse || networkResponse;
    }
    return networkResponse;
  } catch (error) {
    if (request.signal?.aborted) throw error;
    const cachedResponse = initialCachedResponse || await cache.match(request);
    if (cachedResponse) return cachedResponse;
    if (fallbackResponse) return fallbackResponse();
    throw error;
  }
}

async function warmReaderCache() {
  const cache = await caches.open(STATIC_CACHE);
  let nextIndex = 0;

  async function warmNext() {
    while (nextIndex < READER_WARM_URLS.length) {
      const url = READER_WARM_URLS[nextIndex];
      nextIndex += 1;
      const request = new Request(new URL(url, self.location.origin), {
        credentials: 'same-origin',
      });
      if (await cache.match(request)) continue;
      try {
        await cacheFirst(request);
      } catch (error) {
        // Keep successful entries and retry only the missing ones next page load.
        console.warn('Reader cache warm-up failed.', url, error);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(READER_WARM_CONCURRENCY, READER_WARM_URLS.length) },
      () => warmNext(),
    ),
  );
}

function warmReaderCacheOnce() {
  if (!readerWarmPromise) {
    readerWarmPromise = warmReaderCache().finally(() => {
      readerWarmPromise = null;
    });
  }
  return readerWarmPromise;
}

function offlinePage() {
  return new Response(
    '<!doctype html><html lang="tr"><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>Çevrimdışı | Galata Dergisi</title>'
      + '<main><h1>Bağlantı kurulamadı</h1>'
      + '<p>Bu sayfa daha önce çevrimdışı kullanım için kaydedilmemiş.</p></main>',
    {
      status: 503,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    },
  );
}

async function cleanUpObsoleteCaches() {
  const cacheNames = await caches.keys();
  const obsoleteCacheNames = cacheNames.filter(
    (cacheName) => cacheName.startsWith(CACHE_PREFIX) && !ACTIVE_CACHES.has(cacheName),
  );
  await Promise.all(obsoleteCacheNames.map((cacheName) => caches.delete(cacheName)));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(PRECACHE_URLS);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await cleanUpObsoleteCaches();
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'WARM_READER_CACHE') return;
  event.waitUntil(warmReaderCacheOnce());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range')) return;

  const requestURL = new URL(request.url);
  const isSameOrigin = requestURL.origin === self.location.origin;
  if (!isSameOrigin) {
    if (cacheableCrossOriginURLs.some((pattern) => pattern.test(request.url))) {
      event.respondWith(cacheFirst(request));
    }
    return;
  }

  const { pathname } = requestURL;
  if (networkOnlyPaths.some((pattern) => pattern.test(pathname))) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, offlinePage, { adaptiveTimeout: true }));
    return;
  }

  if (networkFirstPaths.some((pattern) => pattern.test(pathname))) {
    event.respondWith(networkFirst(request, null, { adaptiveTimeout: true }));
    return;
  }

  if (STATIC_PATHS.has(pathname) || pathname.startsWith('/images/homepage-covers/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(networkFirst(request));
});
