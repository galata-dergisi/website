import assert from 'assert/strict';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import test from 'node:test';
import { fileURLToPath } from 'url';

import {
  parseDevelopmentOptions,
  waitForFrontendReady,
} from '../scripts/dev.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, '..');

test('development CLI uses loopback workflow defaults', () => {
  const options = parseDevelopmentOptions([], {});
  assert.equal(options.port, 3000);
  assert.match(
    options.mediaRoot,
    /galata-dergisi-static-assets[/\\]server-assets[/\\]public$/,
  );
});

test('development CLI accepts documented flags and rejects unsafe ambiguity', () => {
  const options = parseDevelopmentOptions([
    '--port=3100',
    '--media-root', 'local-media',
  ], {
    LISTEN_ADDR: '0.0.0.0:9999',
    EXTERNAL_MEDIA_DIR: '',
  });
  assert.equal(options.port, 3100);
  assert.equal(path.basename(options.mediaRoot), 'local-media');
  assert.throws(
    () => parseDevelopmentOptions(['--port', '0'], {}),
    /between 1 and 65535/,
  );
  assert.throws(
    () => parseDevelopmentOptions(['--open'], {}),
    /Unknown development option/,
  );
});

test('development uses production-style environment variables as defaults', () => {
  const options = parseDevelopmentOptions([], {
    LISTEN_ADDR: '127.0.0.1:3200',
    EXTERNAL_MEDIA_DIR: 'configured-media',
  });
  assert.equal(options.port, 3200);
  assert.equal(path.basename(options.mediaRoot), 'configured-media');
});

test('development rejects unsafe addresses and empty environment paths', () => {
  [
    '0.0.0.0:3000',
    'localhost:3000',
    '127.0.0.1',
    '127.0.0.1:not-a-port',
  ].forEach((address) => {
    assert.throws(
      () => parseDevelopmentOptions([], { LISTEN_ADDR: address }),
      /LISTEN_ADDR must use 127\.0\.0\.1:<port>/,
    );
  });
  assert.throws(
    () => parseDevelopmentOptions([], { LISTEN_ADDR: '127.0.0.1:65536' }),
    /between 1 and 65535/,
  );
  assert.throws(
    () => parseDevelopmentOptions([], { EXTERNAL_MEDIA_DIR: '  ' }),
    /EXTERNAL_MEDIA_DIR must not be empty/,
  );
});

test('development generates and watches the carousel sheet', () => {
  const developmentSource = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'dev.mjs'),
    'utf8',
  );
  const viteSource = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'build-frontend.mjs'),
    'utf8',
  );
  const gitignoreSource = fs.readFileSync(
    path.join(repoRoot, '.gitignore'),
    'utf8',
  );

  assert.match(
    developmentSource,
    /await generateCarouselSheet\(\);\s+await runNode\(\[frontendBuilder, '--development'\]/,
  );
  assert.match(developmentSource, /carouselSheetWatcher\.on\('all'/);
  assert.match(viteSource, /this\.addWatchFile\(source\)/);
  assert.match(viteSource, /listen\(port, '127\.0\.0\.1', callback\)/);
  assert.match(viteSource, /port: 35729/);
  assert.match(viteSource, /process\.send\(\{ type: frontendReadyMessage \}\)/);
  assert.match(
    developmentSource,
    /await waitForFrontendReady\(frontendBuildChild\);[\s\S]+log\(`ready at/,
  );
  assert.match(
    gitignoreSource,
    /^\/client\/images\/carousel-thumbnail-placeholders\.webp$/m,
  );
});

test('development waits for the watch build readiness signal', async () => {
  const child = new EventEmitter();
  const ready = waitForFrontendReady(child);
  let resolved = false;
  ready.then(() => {
    resolved = true;
  });

  child.emit('message', { type: 'unrelated' });
  await Promise.resolve();
  assert.equal(resolved, false);

  child.emit('message', { type: 'galata-frontend-ready' });
  await ready;
  assert.equal(resolved, true);
});
