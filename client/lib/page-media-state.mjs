// Copyright 2026 Mehmet Baker

import { READER_REQUEST_TIMEOUT_MS } from './request-deadline.mjs';

export const PAGE_MEDIA_STATE = Object.freeze({
  LOADING: 'loading',
  READY: 'ready',
  ERROR: 'error',
});

function mediaType(element) {
  return String(element?.tagName || element?.nodeName || '').toLowerCase();
}

function imageIsReady(image) {
  return Boolean(image.complete && Number(image.naturalWidth) > 0);
}

function videoIsReady(video) {
  const threshold = Number(video.HAVE_CURRENT_DATA) || 2;
  return Number(video.readyState) >= threshold;
}

function mediaIsReady(element, type) {
  return type === 'img' ? imageIsReady(element) : videoIsReady(element);
}

function mediaHasFailed(element, type) {
  if (type === 'img') {
    return Boolean(
      element.complete
      && Number(element.naturalWidth) === 0
      && (attribute(element, 'src') || attribute(element, 'srcset')),
    );
  }
  return Boolean(element.error);
}

function retryUrl(value, attempt) {
  const source = String(value || '');
  if (!source) return source;
  const hashIndex = source.indexOf('#');
  const base = hashIndex === -1 ? source : source.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : source.slice(hashIndex);
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}_galata_retry=${attempt}${hash}`;
}

function retrySrcset(value, attempt) {
  return String(value || '').split(',').map((candidate) => {
    const match = /^(\s*)(\S+)([\s\S]*)$/.exec(candidate);
    if (!match) return candidate;
    return `${match[1]}${retryUrl(match[2], attempt)}${match[3]}`;
  }).join(',');
}

function attribute(element, name) {
  return element.getAttribute?.(name) || '';
}

function setAttribute(element, name, value) {
  if (element.setAttribute) element.setAttribute(name, value);
  else element[name] = value;
}

function createMediaRecord(element) {
  const type = mediaType(element);
  const ready = mediaIsReady(element, type);
  const sources = type === 'video'
    ? Array.from(element.querySelectorAll?.('source') || [])
    : [];
  return {
    element,
    type,
    sources,
    originalSrc: attribute(element, 'src'),
    originalSrcset: type === 'img' ? attribute(element, 'srcset') : '',
    originalSourceUrls: sources.map((source) => attribute(source, 'src')),
    status: ready && !(type === 'img' && typeof element.decode === 'function')
      ? PAGE_MEDIA_STATE.READY
      : mediaHasFailed(element, type) ? PAGE_MEDIA_STATE.ERROR : PAGE_MEDIA_STATE.LOADING,
    timedOut: false,
    generation: 0,
    listeners: [],
  };
}

function refreshMedia(record, attempt) {
  if (record.type === 'img') {
    if (record.originalSrcset) {
      setAttribute(record.element, 'srcset', retrySrcset(record.originalSrcset, attempt));
    }
    if (record.originalSrc) {
      setAttribute(record.element, 'src', retryUrl(record.originalSrc, attempt));
    }
    return;
  }

  if (record.sources.length) {
    record.sources.forEach((source, index) => {
      setAttribute(source, 'src', retryUrl(record.originalSourceUrls[index], attempt));
    });
  } else if (record.originalSrc) {
    setAttribute(record.element, 'src', retryUrl(record.originalSrc, attempt));
  }
  record.element.load?.();
}

export function createPageMediaCoordinator({
  timeoutMs = READER_REQUEST_TIMEOUT_MS,
  timers = globalThis,
  onStateChange = () => {},
} = {}) {
  const pages = new Map();

  function clearTimer(page) {
    if (page.timer === null) return;
    timers.clearTimeout(page.timer);
    page.timer = null;
  }

  function pageState(page) {
    if (page.records.every((record) => record.status === PAGE_MEDIA_STATE.READY)) {
      return PAGE_MEDIA_STATE.READY;
    }
    if (page.records.some((record) => (
      record.status === PAGE_MEDIA_STATE.ERROR || record.timedOut
    ))) {
      return PAGE_MEDIA_STATE.ERROR;
    }
    return PAGE_MEDIA_STATE.LOADING;
  }

  function publish(page) {
    const state = pageState(page);
    page.state = state;
    if (state === PAGE_MEDIA_STATE.READY) clearTimer(page);
    onStateChange(page.element, {
      pageNumber: page.pageNumber,
      state,
      retry: () => retryPage(page.element),
    });
  }

  function startTimer(page) {
    clearTimer(page);
    if (!page.records.some((record) => record.status === PAGE_MEDIA_STATE.LOADING)) return;
    page.timer = timers.setTimeout(() => {
      page.timer = null;
      page.records.forEach((record) => {
        if (record.status === PAGE_MEDIA_STATE.LOADING) record.timedOut = true;
      });
      publish(page);
    }, timeoutMs);
  }

  function settle(page, record, status) {
    if (page.disposed) return;
    record.status = status;
    record.timedOut = false;
    publish(page);
  }

  async function settleImage(page, record) {
    const generation = record.generation;
    try {
      if (typeof record.element.decode === 'function') await record.element.decode();
      if (record.generation === generation && imageIsReady(record.element)) {
        settle(page, record, PAGE_MEDIA_STATE.READY);
      }
    } catch {
      if (record.generation === generation) settle(page, record, PAGE_MEDIA_STATE.ERROR);
    }
  }

  function addListener(page, record, type, listener) {
    record.element.addEventListener(type, listener);
    record.listeners.push([type, listener]);
  }

  function disposePage(element) {
    const page = pages.get(element);
    if (!page) return false;
    page.disposed = true;
    clearTimer(page);
    page.records.forEach((record) => {
      record.listeners.forEach(([type, listener]) => {
        record.element.removeEventListener(type, listener);
      });
      record.listeners = [];
    });
    pages.delete(element);
    return true;
  }

  function watchPage(element, pageNumber) {
    disposePage(element);
    const records = Array.from(element.querySelectorAll('img, video'))
      .map(createMediaRecord)
      .filter((record) => record.type === 'img' || record.type === 'video');
    if (!records.length) {
      onStateChange(element, {
        pageNumber,
        state: PAGE_MEDIA_STATE.READY,
        retry: () => false,
      });
      return PAGE_MEDIA_STATE.READY;
    }

    const page = {
      attempt: 0,
      disposed: false,
      element,
      pageNumber,
      records,
      state: PAGE_MEDIA_STATE.LOADING,
      timer: null,
    };
    pages.set(element, page);
    records.forEach((record) => {
      const readyEvent = record.type === 'img' ? 'load' : 'loadeddata';
      addListener(page, record, readyEvent, () => {
        if (mediaIsReady(record.element, record.type)) {
          if (record.type === 'img') void settleImage(page, record);
          else settle(page, record, PAGE_MEDIA_STATE.READY);
        }
      });
      addListener(page, record, 'error', () => {
        settle(page, record, PAGE_MEDIA_STATE.ERROR);
      });
      if (
        record.type === 'img'
        && record.status !== PAGE_MEDIA_STATE.READY
        && imageIsReady(record.element)
      ) {
        void settleImage(page, record);
      }
    });
    startTimer(page);
    publish(page);
    return page.state;
  }

  function retryPage(element) {
    const page = pages.get(element);
    if (!page || page.disposed) return false;
    const retryRecords = page.records.filter((record) => (
      record.status === PAGE_MEDIA_STATE.ERROR || record.timedOut
    ));
    if (!retryRecords.length) return false;

    page.attempt += 1;
    retryRecords.forEach((record) => {
      record.generation += 1;
      record.status = PAGE_MEDIA_STATE.LOADING;
      record.timedOut = false;
      refreshMedia(record, page.attempt);
    });
    startTimer(page);
    publish(page);
    return true;
  }

  return {
    watchPage,
    retryPage,
    disposePage,
    dispose() {
      Array.from(pages.keys()).forEach(disposePage);
    },
    getState: (element) => pages.get(element)?.state || PAGE_MEDIA_STATE.READY,
  };
}
