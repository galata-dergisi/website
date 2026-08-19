// Copyright 2026 Mehmet Baker

export function createAudioPlayerViewManager({
  root,
  playersById,
  createView,
  destroyView,
}) {
  const views = new Map();

  function mountWithin(scope) {
    if (!scope) return;
    const mountPoints = scope.querySelectorAll('[data-audio-player-id]');
    for (let index = 0; index < mountPoints.length; index += 1) {
      const mountPoint = mountPoints[index];
      if (views.has(mountPoint)) continue;
      const player = playersById.get(mountPoint.dataset.audioPlayerId);
      if (!player) continue;
      mountPoint.innerHTML = '';
      views.set(mountPoint, createView(mountPoint, player));
    }
  }

  function reconcile() {
    views.forEach((view, mountPoint) => {
      if (mountPoint.isConnected && root.contains(mountPoint)) return;
      destroyView(view);
      views.delete(mountPoint);
    });
    mountWithin(root);
  }

  function dispose() {
    views.forEach((view) => destroyView(view));
    views.clear();
  }

  return {
    mountWithin,
    reconcile,
    dispose,
    getMountedCount: () => views.size,
  };
}
