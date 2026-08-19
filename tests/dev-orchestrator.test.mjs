import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import test from 'node:test';
import { fileURLToPath } from 'url';

import { parseDevelopmentOptions } from '../scripts/dev.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, '..');

test('development CLI uses loopback workflow defaults', () => {
  const options = parseDevelopmentOptions([], {});
  assert.equal(options.port, 3000);
  assert.match(
    options.mediaRoot,
    /galata-dergisi-static-assets[/\\]server-assets[/\\]public$/,
  );
  assert.equal(path.basename(options.contributionsDir), 'contributions');
});

test('development CLI accepts documented flags and rejects unsafe ambiguity', () => {
  const options = parseDevelopmentOptions([
    '--port=3100',
    '--media-root', 'local-media',
    '--contributions-dir', 'local-inbox',
  ], {
    LISTEN_ADDR: '0.0.0.0:9999',
    EXTERNAL_MEDIA_DIR: '',
    CONTRIBUTIONS_DIR: '',
  });
  assert.equal(options.port, 3100);
  assert.equal(path.basename(options.mediaRoot), 'local-media');
  assert.equal(path.basename(options.contributionsDir), 'local-inbox');
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
    CONTRIBUTIONS_DIR: 'configured-inbox',
    TURNSTILE_SECRET_KEY: 'not-used-in-development',
  });
  assert.equal(options.port, 3200);
  assert.equal(path.basename(options.mediaRoot), 'configured-media');
  assert.equal(path.basename(options.contributionsDir), 'configured-inbox');
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
  assert.throws(
    () => parseDevelopmentOptions([], { CONTRIBUTIONS_DIR: '' }),
    /CONTRIBUTIONS_DIR must not be empty/,
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
  assert.match(
    gitignoreSource,
    /^\/client\/images\/carousel-thumbnail-placeholders\.webp$/m,
  );
});
