import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPageMediaCoordinator,
  PAGE_MEDIA_STATE,
} from '../client/lib/page-media-state.mjs';

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

class FakeSource {
  constructor(src) {
    this.attributes = new Map([['src', src]]);
  }

  getAttribute(name) {
    return this.attributes.get(name) || '';
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}

class FakeMedia extends EventTarget {
  constructor(tagName, {
    attrs = {},
    complete = false,
    decode,
    error = null,
    naturalWidth = 0,
    readyState = 0,
    sources = [],
  } = {}) {
    super();
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attrs));
    this.complete = complete;
    this.error = error;
    this.naturalWidth = naturalWidth;
    this.readyState = readyState;
    this.HAVE_CURRENT_DATA = 2;
    this.sources = sources;
    this.loadCount = 0;
    if (decode) this.decode = decode;
  }

  getAttribute(name) {
    return this.attributes.get(name) || '';
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  querySelectorAll(selector) {
    return selector === 'source' ? this.sources : [];
  }

  load() {
    this.loadCount += 1;
  }
}

class FakePage {
  constructor(media = []) {
    this.media = media;
  }

  querySelectorAll(selector) {
    return selector === 'img, video' ? this.media : [];
  }
}

test('text-only and already available page media are immediately ready', () => {
  const timers = createManualTimers();
  const states = [];
  const coordinator = createPageMediaCoordinator({
    timers,
    onStateChange: (_page, detail) => states.push(detail.state),
  });
  const textPage = new FakePage();
  const loadedPage = new FakePage([
    new FakeMedia('img', {
      attrs: { src: '/cover.jpg' },
      complete: true,
      naturalWidth: 500,
    }),
    new FakeMedia('video', { readyState: 2 }),
  ]);

  assert.equal(coordinator.watchPage(textPage, 2), PAGE_MEDIA_STATE.READY);
  assert.equal(coordinator.watchPage(loadedPage, 3), PAGE_MEDIA_STATE.READY);
  assert.deepEqual(states, [PAGE_MEDIA_STATE.READY, PAGE_MEDIA_STATE.READY]);
  assert.equal(timers.pendingCount(), 0);
});

test('waits for image decoding before clearing page-local loading feedback', async () => {
  let finishDecode;
  const decode = new Promise((resolve) => { finishDecode = resolve; });
  const states = [];
  const image = new FakeMedia('img', {
    attrs: { src: '/cover.jpg' },
    complete: true,
    naturalWidth: 500,
    decode: () => decode,
  });
  const page = new FakePage([image]);
  const coordinator = createPageMediaCoordinator({
    onStateChange: (_page, detail) => states.push(detail.state),
  });

  assert.equal(coordinator.watchPage(page, 1), PAGE_MEDIA_STATE.LOADING);
  finishDecode();
  await decode;
  await Promise.resolve();
  assert.equal(coordinator.getState(page), PAGE_MEDIA_STATE.READY);
  assert.deepEqual(states, [PAGE_MEDIA_STATE.LOADING, PAGE_MEDIA_STATE.READY]);
  coordinator.dispose();
});

test('shows a retry state after ten seconds and clears it on late success', () => {
  const timers = createManualTimers();
  const updates = [];
  const image = new FakeMedia('img', { attrs: { src: '/slow.jpg' }});
  const page = new FakePage([image]);
  const coordinator = createPageMediaCoordinator({
    timers,
    timeoutMs: 10_000,
    onStateChange: (_page, detail) => updates.push(detail),
  });

  assert.equal(coordinator.watchPage(page, 7), PAGE_MEDIA_STATE.LOADING);
  assert.equal(timers.fire(10_000), true);
  assert.equal(coordinator.getState(page), PAGE_MEDIA_STATE.ERROR);
  assert.equal(updates.at(-1).pageNumber, 7);

  image.complete = true;
  image.naturalWidth = 500;
  image.dispatchEvent(new Event('load'));
  assert.equal(coordinator.getState(page), PAGE_MEDIA_STATE.READY);
  assert.equal(timers.pendingCount(), 0);
});

test('retries only failed media with cache-busted requests', () => {
  const timers = createManualTimers();
  const failed = new FakeMedia('img', { attrs: { src: '/failed.jpg?size=500' }});
  const pending = new FakeMedia('img', { attrs: { src: '/pending.jpg' }});
  const page = new FakePage([failed, pending]);
  let retry;
  const coordinator = createPageMediaCoordinator({
    timers,
    onStateChange: (_page, detail) => { retry = detail.retry; },
  });
  coordinator.watchPage(page, 8);
  failed.dispatchEvent(new Event('error'));

  assert.equal(retry(), true);
  assert.equal(failed.getAttribute('src'), '/failed.jpg?size=500&_galata_retry=1');
  assert.equal(pending.getAttribute('src'), '/pending.jpg');
  assert.equal(coordinator.getState(page), PAGE_MEDIA_STATE.LOADING);
  assert.equal(timers.pendingCount(), 1);
});

test('video retries preserve editorial playback attributes', () => {
  const timers = createManualTimers();
  const source = new FakeSource('/cover.mp4');
  const attributes = {
    autoplay: '',
    controls: '',
    loop: '',
    muted: '',
    playsinline: '',
    preload: 'auto',
  };
  const video = new FakeMedia('video', { attrs: attributes, sources: [source] });
  const page = new FakePage([video]);
  let retry;
  const coordinator = createPageMediaCoordinator({
    timers,
    onStateChange: (_page, detail) => { retry = detail.retry; },
  });
  coordinator.watchPage(page, 1);
  video.dispatchEvent(new Event('error'));

  assert.equal(retry(), true);
  assert.equal(source.getAttribute('src'), '/cover.mp4?_galata_retry=1');
  assert.equal(video.loadCount, 1);
  Object.entries(attributes).forEach(([name, value]) => {
    assert.equal(video.getAttribute(name), value);
  });
});

test('teardown removes media listeners and deadlines', () => {
  const timers = createManualTimers();
  const states = [];
  const image = new FakeMedia('img', { attrs: { src: '/slow.jpg' }});
  const page = new FakePage([image]);
  const coordinator = createPageMediaCoordinator({
    timers,
    onStateChange: (_page, detail) => states.push(detail.state),
  });
  coordinator.watchPage(page, 4);

  assert.equal(coordinator.disposePage(page), true);
  assert.equal(timers.pendingCount(), 0);
  image.complete = true;
  image.naturalWidth = 500;
  image.dispatchEvent(new Event('load'));
  assert.deepEqual(states, [PAGE_MEDIA_STATE.LOADING]);
});
