import assert from 'node:assert/strict';
import test from 'node:test';

import { createReaderTransitionCoordinator } from '../client/lib/reader-transition.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('keeps only the latest navigation current across an outgoing reader', async () => {
  const coordinator = createReaderTransitionCoordinator();
  const transition = deferred();
  const mountedIssues = [];

  async function mountAfterOutro(issue) {
    const navigation = coordinator.beginNavigation();
    await transition.promise;
    if (coordinator.isCurrentNavigation(navigation)) mountedIssues.push(issue);
  }

  const staleLoad = mountAfterOutro(46);
  const latestLoad = mountAfterOutro(47);
  transition.resolve();
  await Promise.all([staleLoad, latestLoad]);

  assert.deepEqual(mountedIssues, [47]);
});

test('returning home invalidates an issue waiting for the outro', async () => {
  const coordinator = createReaderTransitionCoordinator();
  const transition = deferred();
  let mounted = false;
  const navigation = coordinator.beginNavigation();
  const pendingLoad = transition.promise.then(() => {
    if (coordinator.isCurrentNavigation(navigation)) mounted = true;
  });

  coordinator.invalidateNavigation();
  transition.resolve();
  await pendingLoad;

  assert.equal(mounted, false);
});

test('coalesces repeated unloads and applies the latest focus preference', async () => {
  const coordinator = createReaderTransitionCoordinator();
  let outroStarts = 0;
  const first = coordinator.beginOutro(() => {
    outroStarts += 1;
  }, { restoreFocus: false });
  const second = coordinator.beginOutro(() => {
    outroStarts += 1;
  }, { restoreFocus: true });

  assert.equal(first, second);
  assert.equal(outroStarts, 1);
  assert.equal(coordinator.hasPendingOutro(), true);

  const result = coordinator.finishOutro();
  await Promise.all([first, second]);

  assert.deepEqual(result, { hadPendingOutro: true, restoreFocus: true });
  assert.equal(coordinator.hasPendingOutro(), false);
  assert.deepEqual(
    coordinator.finishOutro(),
    { hadPendingOutro: false, restoreFocus: false },
  );
});
