// Copyright 2026 Mehmet Baker

import {
  READER_REQUEST_TIMEOUT_MS,
  withRequestDeadline,
} from './request-deadline.mjs';

function isNonEmptyPageMap(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length,
  );
}

export async function fetchMagazinePages(
  issue,
  {
    fetchImpl = globalThis.fetch,
    signal,
    timeoutMs = READER_REQUEST_TIMEOUT_MS,
    timers = globalThis,
  } = {},
) {
  return withRequestDeadline(async (requestSignal) => {
    const response = await fetchImpl(`/magazines/${issue}/pages`, {
      signal: requestSignal,
    });
    if (!response.ok) {
      throw new Error(`Magazine pages request failed with status ${response.status}.`);
    }

    const result = await response.json();
    if (result?.success !== true || !isNonEmptyPageMap(result.pages)) {
      throw new Error(result?.message || 'Magazine pages response is invalid.');
    }

    return {
      pages: result.pages,
      audioPlayers: result.audioPlayers || {},
    };
  }, { signal, timeoutMs, timers });
}
