import assert from 'assert/strict';
import vm from 'vm';

export const defaultOrigin = 'https://galatadergisi.org';

export function requestURL(request, origin = defaultOrigin) {
  const value = typeof request === 'string' ? request : request.url;
  return new URL(value, origin).href;
}

export function requestKey(request, origin = defaultOrigin) {
  const method = typeof request === 'string' ? 'GET' : (request.method || 'GET');
  return `${method}:${requestURL(request, origin)}`;
}

export function makeRequest(pathOrURL, {
  method = 'GET',
  mode = 'cors',
  range = null,
  signal = null,
} = {}, origin = defaultOrigin) {
  const headers = new Headers();
  if (range) headers.set('Range', range);

  const request = {
    url: new URL(pathOrURL, origin).href,
    method,
    mode,
    headers,
  };
  if (signal) request.signal = signal;
  return request;
}

class FakeCache {
  constructor(storage, name) {
    this.storage = storage;
    this.name = name;
    this.responses = new Map();
  }

  async addAll(urls) {
    for (const url of urls) {
      const request = makeRequest(url, {}, this.storage.origin);
      const response = await this.storage.fetchNetwork(request);
      if (!response || (!response.ok && response.type !== 'opaque')) {
        throw new Error(`Precache request failed: ${request.url}`);
      }
      await this.put(request, response);
    }
  }

  async match(request) {
    const response = this.responses.get(requestKey(request, this.storage.origin));
    return response ? response.clone() : undefined;
  }

  async put(request, response) {
    assert.equal(
      typeof request === 'string' ? 'GET' : request.method,
      'GET',
      'only GET responses may be cached',
    );
    const source = response.clone();
    const body = source.body ? await source.arrayBuffer() : null;
    this.responses.set(
      requestKey(request, this.storage.origin),
      new Response(body, {
        status: source.status,
        statusText: source.statusText,
        headers: source.headers,
      }),
    );
  }

  async keys() {
    return Array.from(this.responses.keys()).map((key) => {
      const separator = key.indexOf(':');
      return {
        method: key.slice(0, separator),
        url: key.slice(separator + 1),
      };
    });
  }

  async delete(request) {
    return this.responses.delete(requestKey(request, this.storage.origin));
  }
}

export class FakeCacheStorage {
  constructor({
    origin = defaultOrigin,
    networkFetch = async (request) => new Response(
      `network:${request.url || request}`,
      { status: 200 },
    ),
  } = {}) {
    this.origin = origin;
    this.networkFetch = networkFetch;
    this.cacheStores = new Map();
    this.deletedCacheNames = [];
  }

  setNetworkFetch(networkFetch) {
    this.networkFetch = networkFetch;
  }

  async fetchNetwork(request, options) {
    return this.networkFetch(request, options);
  }

  async open(name) {
    if (!this.cacheStores.has(name)) {
      this.cacheStores.set(name, new FakeCache(this, name));
    }
    return this.cacheStores.get(name);
  }

  async match(request) {
    for (const cache of this.cacheStores.values()) {
      const response = await cache.match(request);
      if (response) return response;
    }
    return undefined;
  }

  async keys() {
    return Array.from(this.cacheStores.keys());
  }

  async delete(name) {
    this.deletedCacheNames.push(name);
    return this.cacheStores.delete(name);
  }

  async seed(name, request, response) {
    const cache = await this.open(name);
    await cache.put(makeRequest(request, {}, this.origin), response);
  }
}

function lifecycleEvent() {
  const promises = [];
  return {
    waitUntil(promise) {
      promises.push(Promise.resolve(promise));
    },
    async done() {
      await Promise.all(promises);
    },
  };
}

function fetchEvent(request) {
  let responsePromise = null;

  return {
    request,
    respondWith(response) {
      assert.equal(responsePromise, null, 'respondWith must only be called once');
      responsePromise = Promise.resolve(response);
    },
    wasIntercepted() {
      return responsePromise !== null;
    },
    async response() {
      assert.ok(responsePromise, `request was not intercepted: ${request.url}`);
      return responsePromise;
    },
  };
}

export class ServiceWorkerHarness {
  constructor(source, {
    filename = 'service-worker.js',
    origin = defaultOrigin,
    storage = new FakeCacheStorage({ origin }),
    timers = { setTimeout, clearTimeout },
  } = {}) {
    this.filename = filename;
    this.origin = origin;
    this.storage = storage;
    this.listeners = new Map();
    this.skipWaitingCalled = false;
    this.clientsClaimed = false;

    const serviceWorkerGlobal = {
      location: new URL('/service-worker.js', origin),
      clients: {
        claim: async () => {
          this.clientsClaimed = true;
        },
      },
      skipWaiting: async () => {
        this.skipWaitingCalled = true;
      },
      addEventListener: (type, listener) => {
        this.listeners.set(type, listener);
      },
    };

    vm.runInNewContext(source, {
      URL,
      Response,
      Headers,
      Request,
      caches: storage,
      console: {
        trace() {},
        warn() {},
      },
      AbortController,
      clearTimeout: timers.clearTimeout,
      fetch: (request, options) => storage.fetchNetwork(request, options),
      location: serviceWorkerGlobal.location,
      self: serviceWorkerGlobal,
      setTimeout: timers.setTimeout,
    }, {
      filename,
    });
  }

  assertListeners(eventNames = ['install', 'activate', 'fetch']) {
    eventNames.forEach((eventName) => {
      assert.equal(
        typeof this.listeners.get(eventName),
        'function',
        `${eventName} handler must exist`,
      );
    });
  }

  async install() {
    const event = lifecycleEvent();
    this.listeners.get('install')(event);
    await event.done();
  }

  async activate() {
    const event = lifecycleEvent();
    this.listeners.get('activate')(event);
    await event.done();
  }

  async dispatchMessage(data) {
    const event = lifecycleEvent();
    event.data = data;
    this.listeners.get('message')(event);
    await event.done();
  }

  dispatchFetch(request) {
    const event = fetchEvent(request);
    this.listeners.get('fetch')(event);
    return event;
  }

  async handleRequest(pathOrRequest, options = {}) {
    const request = typeof pathOrRequest === 'string'
      ? makeRequest(pathOrRequest, options, this.origin)
      : pathOrRequest;
    const event = this.dispatchFetch(request);
    return event.wasIntercepted()
      ? event.response()
      : this.storage.fetchNetwork(request);
  }
}
