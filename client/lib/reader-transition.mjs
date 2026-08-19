// Copyright 2026 Mehmet Baker

export function createReaderTransitionCoordinator() {
  let navigationSequence = 0;
  let pendingOutro = null;
  let restoreFocusAfterOutro = false;

  function beginNavigation() {
    navigationSequence += 1;
    return navigationSequence;
  }

  function beginOutro(startOutro, { restoreFocus = true } = {}) {
    restoreFocusAfterOutro = Boolean(restoreFocus);
    if (pendingOutro) return pendingOutro.promise;

    let resolveOutro;
    const promise = new Promise((resolve) => {
      resolveOutro = resolve;
    });
    pendingOutro = { promise, resolve: resolveOutro };

    try {
      startOutro();
    } catch (error) {
      pendingOutro = null;
      restoreFocusAfterOutro = false;
      resolveOutro();
      throw error;
    }

    return promise;
  }

  function finishOutro() {
    const outro = pendingOutro;
    const result = {
      hadPendingOutro: Boolean(outro),
      restoreFocus: restoreFocusAfterOutro,
    };
    pendingOutro = null;
    restoreFocusAfterOutro = false;
    if (outro) outro.resolve();
    return result;
  }

  return {
    beginNavigation,
    invalidateNavigation: beginNavigation,
    isCurrentNavigation: (sequence) => sequence === navigationSequence,
    beginOutro,
    finishOutro,
    hasPendingOutro: () => Boolean(pendingOutro),
  };
}
