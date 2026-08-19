import assert from 'node:assert/strict';
import test from 'node:test';

import {
  shouldHandleClientNavigation,
  shouldHandleDirectionalNavigation,
} from '../client/lib/link-navigation.mjs';

function anchor({ target = null, download = false } = {}) {
  return {
    getAttribute: (name) => (name === 'target' ? target : null),
    hasAttribute: (name) => name === 'download' && download,
  };
}

function event(overrides = {}) {
  return {
    altKey: false,
    button: 0,
    ctrlKey: false,
    defaultPrevented: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

test('handles ordinary primary clicks and keyboard-generated clicks', () => {
  assert.equal(shouldHandleClientNavigation(event(), anchor()), true);
  assert.equal(shouldHandleClientNavigation(event({ detail: 0 }), anchor()), true);
  assert.equal(shouldHandleClientNavigation(event(), anchor({ target: '_self' })), true);
});

test('leaves modified and non-primary clicks to the browser', () => {
  ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'].forEach((modifier) => {
    assert.equal(
      shouldHandleClientNavigation(event({ [modifier]: true }), anchor()),
      false,
    );
  });
  assert.equal(shouldHandleClientNavigation(event({ button: 1 }), anchor()), false);
  assert.equal(shouldHandleClientNavigation(event({ button: 2 }), anchor()), false);
});

test('leaves targeted, downloaded, and previously handled links to native behavior', () => {
  assert.equal(shouldHandleClientNavigation(event(), anchor({ target: '_blank' })), false);
  assert.equal(shouldHandleClientNavigation(event(), anchor({ target: 'reader' })), false);
  assert.equal(shouldHandleClientNavigation(event(), anchor({ download: true })), false);
  assert.equal(
    shouldHandleClientNavigation(event({ defaultPrevented: true }), anchor()),
    false,
  );
});

test('handles only unmodified and unhandled horizontal arrow navigation', () => {
  assert.equal(shouldHandleDirectionalNavigation(event({ key: 'ArrowLeft' })), true);
  assert.equal(shouldHandleDirectionalNavigation(event({ key: 'ArrowRight' })), true);
  assert.equal(shouldHandleDirectionalNavigation(event({ key: 'ArrowUp' })), false);
  assert.equal(shouldHandleDirectionalNavigation(event({ key: 'Enter' })), false);
  assert.equal(shouldHandleDirectionalNavigation(null), false);

  ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'].forEach((modifier) => {
    assert.equal(
      shouldHandleDirectionalNavigation(event({ key: 'ArrowLeft', [modifier]: true })),
      false,
    );
  });
  assert.equal(
    shouldHandleDirectionalNavigation(event({ key: 'ArrowRight', defaultPrevented: true })),
    false,
  );
});
