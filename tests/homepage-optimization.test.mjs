import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  READER_CACHE_WARM_GRACE_MS,
  shouldWarmReaderCache,
} from '../client/lib/reader-cache-policy.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, '..');
const siteRoot = path.join(projectRoot, 'internal/site/dist');

function readJson(relativeFile) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativeFile), 'utf8'));
}

function readRoute(route) {
  const site = readJson('internal/site/dist/manifest.json');
  const entry = site.routes[route];
  assert.ok(entry, `generated route is missing: ${route}`);
  return {
    content: fs.readFileSync(path.join(siteRoot, entry.file)),
    entry,
  };
}

test('homepage AVIFs are deterministic, correctly sized, and immutable', async () => {
  const manifest = readJson('build/homepage-images.json');
  assert.deepEqual(manifest.settings, {
    coverSizes: [
      { width: 100, height: 140 },
      { width: 180, height: 252 },
    ],
    effort: 7,
    fit: 'cover',
    quality: 50,
  });
  assert.equal(Object.keys(manifest.covers).length, 47);

  const assets = [
    ...Object.values(manifest.artwork),
    ...Object.values(manifest.covers).flatMap((cover) => cover.avif),
  ];
  for (const asset of assets) {
    const content = fs.readFileSync(path.join(projectRoot, asset.file));
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    assert.equal(sha256, asset.sha256);
    assert.match(asset.url, new RegExp(`\\.${sha256.slice(0, 16)}\\.avif$`));
    const metadata = await sharp(content).metadata();
    assert.equal(metadata.format, 'heif');
    assert.equal(metadata.compression, 'av1');
    assert.equal(metadata.width, asset.width);
    assert.equal(metadata.height, asset.height);

    const route = readRoute(asset.url);
    assert.equal(route.entry.contentType, 'image/avif');
    assert.equal(route.entry.cacheControl, 'public, max-age=31536000, immutable');
    assert.equal(route.content.length, asset.size);
  }
});

test('homepage markup uses optimized image sources and the unified application bundle', () => {
  const shell = readJson('build/shell-assets.json');
  const home = readRoute('/').content.toString('utf8');
  const directReader = readRoute('/dergiler/sayi47').content.toString('utf8');
  const magazineList = JSON.parse(readRoute('/magazines').content.toString('utf8'));

  assert.equal((home.match(/<picture[^>]*>/g) || []).length, 4);
  assert.equal((home.match(/<source[^>]+type="image\/avif"/g) || []).length, 4);
  assert.match(home, /<img src="\/images\/header-logo\.svg\?v=[a-f0-9]{16}"/);
  assert.equal((home.match(/loading="lazy"/g) || []).length, 3);
  assert.match(
    home,
    /<img src="\/images\/sayi47\/thumbnail\.jpg"[^>]+loading="eager"[^>]+fetchpriority="high"/,
  );
  assert.match(home, /srcset="\/images\/homepage-covers\/sayi47-100\.[a-f0-9]{16}\.avif 100w, \/images\/homepage-covers\/sayi47-180\.[a-f0-9]{16}\.avif 180w"/);
  assert.match(home, /<img src="\/images\/sayi47\/thumbnail\.jpg"/);
  assert.match(
    home,
    /<link rel="preload" as="image" type="image\/webp" href="\/images\/carousel-thumbnail-placeholders\.webp\?v=[a-f0-9]{16}" \/>/,
  );
  assert.doesNotMatch(
    directReader,
    /<link rel="preload"[^>]+carousel-thumbnail-placeholders\.webp/,
  );
  for (const document_ of [home, directReader]) {
    assert.equal(document_.includes(shell.assets['/bundle.js'].url), true);
    assert.equal(document_.includes(shell.assets['/bundle.css'].url), true);
    assert.doesNotMatch(document_, /modulepreload|\/assets\/reader-/);
  }
  assert.deepEqual(
    magazineList.magazines[0].thumbnailSources.avif.map(({ width }) => width),
    [100, 180],
  );
  assert.equal(magazineList.magazines[0].thumbnailURL, '/images/sayi47/thumbnail.jpg');
});

test('reader, page-turn, and audio-player code share one homepage entry', () => {
  const browser = readJson('public/.vite/manifest.json');
  const homepage = browser['client/pages/homepage/index.js'];
  assert.deepEqual(Object.keys(browser), ['client/pages/homepage/index.js']);
  assert.equal(homepage.isEntry, true);
  assert.deepEqual(homepage.dynamicImports || [], []);
  assert.deepEqual(homepage.css, ['bundle.css']);
  const homePageSource = fs.readFileSync(
    path.join(projectRoot, 'client/pages/homepage/HomePage.svelte'),
    'utf8',
  );
  const magazineSource = fs.readFileSync(
    path.join(projectRoot, 'client/pages/homepage/components/Magazine.svelte'),
    'utf8',
  );
  assert.match(homePageSource, /import Magazine from '.\/components\/Magazine\.svelte'/);
  assert.match(homePageSource, /import IconSprite from '.\/components\/IconSprite\.svelte'/);
  assert.match(homePageSource, /import '\.\.\/\.\.\/styles\/layout\.scss'/);
  assert.match(magazineSource, /import AudioPlayer from '.\/AudioPlayer\.svelte'/);
  assert.match(magazineSource, /import \{ PageTurn \} from '.+page-turn\.mjs'/);
});

test('reader cache warming skips offline and explicitly constrained connections', () => {
  assert.equal(READER_CACHE_WARM_GRACE_MS, 3_000);
  assert.equal(shouldWarmReaderCache(), true);
  assert.equal(shouldWarmReaderCache({ online: false }), false);
  assert.equal(shouldWarmReaderCache({ connection: { saveData: true }}), false);
  assert.equal(shouldWarmReaderCache({ connection: { effectiveType: 'slow-2g' }}), false);
  assert.equal(shouldWarmReaderCache({ connection: { effectiveType: '2g' }}), false);
  assert.equal(shouldWarmReaderCache({ connection: { effectiveType: '3g' }}), true);
});

test('analytics, hosted fonts, and eager service-worker registration are absent', () => {
  const homepageTemplate = fs.readFileSync(
    path.join(projectRoot, 'client/pages/homepage/index.html'),
    'utf8',
  );
  const homepageEntry = fs.readFileSync(
    path.join(projectRoot, 'client/pages/homepage/index.js'),
    'utf8',
  );
  assert.doesNotMatch(
    homepageTemplate,
    /googletag|google-analytics|fonts\.googleapis/i,
  );
  assert.match(homepageEntry, /window\.addEventListener\('load'/);
  assert.match(homepageEntry, /requestIdleCallback\(warm, \{ timeout: 10_000 \}\)/);
  assert.match(homepageEntry, /READER_CACHE_WARM_GRACE_MS/);
  assert.match(homepageEntry, /shouldWarmReaderCache/);
  assert.match(homepageEntry, /postMessage\(\{ type: 'WARM_READER_CACHE' \}\)/);
  assert.doesNotMatch(homepageEntry, /import\(['"]\.\/reader\.js['"]\)/);
});
