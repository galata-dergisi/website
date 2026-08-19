// Copyright 2026 Mehmet Baker

export const READER_REQUEST_TIMEOUT_MS = 10_000;

function networkTimeoutError() {
  const error = new Error('Network request timed out.');
  error.name = 'NetworkTimeoutError';
  return error;
}

export async function withRequestDeadline(operation, {
  signal: callerSignal,
  timeoutMs = READER_REQUEST_TIMEOUT_MS,
  timers = globalThis,
} = {}) {
  const controller = new AbortController();
  let abortSource = null;
  let timeoutError = null;
  let rejectDeadline;

  const deadline = new Promise((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const forwardCallerAbort = () => {
    if (abortSource !== null) return;
    abortSource = 'caller';
    controller.abort(callerSignal.reason);
  };

  if (callerSignal?.aborted) {
    forwardCallerAbort();
  } else {
    callerSignal?.addEventListener('abort', forwardCallerAbort, { once: true });
  }

  const timer = abortSource === null
    ? timers.setTimeout(() => {
      if (abortSource !== null) return;
      abortSource = 'timeout';
      timeoutError = networkTimeoutError();
      rejectDeadline(timeoutError);
      controller.abort();
    }, timeoutMs)
    : null;

  try {
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    return await Promise.race([operationPromise, deadline]);
  } catch (error) {
    if (abortSource === 'timeout') throw timeoutError || networkTimeoutError();
    throw error;
  } finally {
    if (timer !== null) timers.clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardCallerAbort);
  }
}
