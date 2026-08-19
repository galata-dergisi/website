import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pageTurnBezier,
  pageTurnEasing,
  pageTurnRange,
  pageTurnStacking,
  pageTurnView,
} from '../client/lib/page-turn-math.mjs';

test('double-page views preserve the legacy even/odd pairing', () => {
  assert.deepEqual(pageTurnView(1), [0, 1]);
  assert.deepEqual(pageTurnView(2), [2, 3]);
  assert.deepEqual(pageTurnView(3), [2, 3]);
  assert.deepEqual(pageTurnView(10), [10, 11]);
});

test('range maintains the six-page DOM window at every boundary', () => {
  const expected = [
    [1, 6],
    [1, 6],
    [1, 6],
    [2, 7],
    [2, 7],
    [4, 9],
    [4, 9],
    [5, 10],
    [5, 10],
    [5, 10],
  ];

  expected.forEach((range, index) => {
    assert.deepEqual(pageTurnRange(index + 1, 10, 6), range);
    assert.equal(range[1] - range[0] + 1, 6);
  });
});

test('Bézier folding points retain integer rounding', () => {
  const p1 = { x: 500, y: 700 };
  const p2 = { x: 500, y: 650 };
  const p3 = { x: 0, y: 50 };
  const p4 = { x: 0, y: 0 };

  assert.deepEqual(pageTurnBezier(p1, p2, p3, p4, 0), p1);
  assert.deepEqual(pageTurnBezier(p1, p2, p3, p4, 0.5), { x: 250, y: 350 });
  assert.deepEqual(pageTurnBezier(p1, p2, p3, p4, 1), p4);
});

test('animation easing preserves the legacy circular curve', () => {
  assert.equal(pageTurnEasing(0, 10, 90, 600), 10);
  assert.equal(pageTurnEasing(600, 10, 90, 600), 100);
  assert.equal(pageTurnEasing(300, 10, 90, 600), 10 + 90 * Math.sqrt(0.75));
});

test('stacking calculation preserves moving page visibility and z-indexes', () => {
  assert.deepEqual(
    pageTurnStacking([3], 10, [2, 3], { 3: 4 }, { 3: 3, 4: 4 }),
    {
      pageZ: { 4: 8 },
      partZ: { 3: 22 },
      pageV: { 2: true, 3: true, 4: true, 5: true },
    },
  );
});
