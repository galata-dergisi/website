import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCachePurgeManifest } from '../scripts/generate-cache-purge-manifest.mjs';

function fixture(t, policy, routes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'galata-cache-manifest-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const policyFile = path.join(root, 'policy.json');
  const siteManifestFile = path.join(root, 'site.json');
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  fs.writeFileSync(siteManifestFile, JSON.stringify({ routes }));
  return { policyFile, siteManifestFile };
}

test('creates a deterministic stable-URL manifest from generated route ETags', (t) => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const files = fixture(t, {
    version: 1,
    stableCachedPaths: ['/second', '/'],
  }, {
    '/': { etag: `"${a}"` },
    '/second': { etag: `"${b}"` },
  });
  assert.equal(
    createCachePurgeManifest(files),
    `format=1\n${a}  /\n${b}  /second\n`,
  );
});

test('supports removing the final stable cached URL', (t) => {
  const files = fixture(t, { version: 1, stableCachedPaths: [] }, {});
  assert.equal(createCachePurgeManifest(files), 'format=1\n');
});

test('rejects duplicate, unsafe, absent, and weakly identified cache paths', (t) => {
  const hash = 'a'.repeat(64);
  for (const [paths, routes, expected] of [
    [['/', '/'], { '/': { etag: `"${hash}"` }}, /unique/],
    [['/unsafe path'], { '/unsafe path': { etag: `"${hash}"` }}, /Unsafe/],
    [['/missing'], {}, /absent/],
    [['/'], { '/': { etag: 'W/"weak"' }}, /strong SHA-256/],
  ]) {
    const files = fixture(t, { version: 1, stableCachedPaths: paths }, routes);
    assert.throws(() => createCachePurgeManifest(files), expected);
  }
});
