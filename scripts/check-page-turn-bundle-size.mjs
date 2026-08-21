#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const require = createRequire(import.meta.url);
const { readBrowserAssetManifest } = require('./lib/browser-assets.js');
const {
  allHomepageImageAssets,
  readHomepageImageManifest,
} = require('./lib/homepage-images.js');
const {
  readShellAssetManifest,
  shellAssetEntries,
} = require('./lib/shell-assets.js');

const HOMEPAGE_TRANSFER_CEILING = 110_000;
const INSTALL_OVERHEAD_CEILING = 20_000;
const HOMEPAGE_JS_GZIP_CEILING = 50_000;

const browser = readBrowserAssetManifest(projectRoot);
const homepageImages = readHomepageImageManifest(projectRoot);
const shell = readShellAssetManifest(projectRoot);
const siteRoot = path.join(projectRoot, 'internal/site/dist');
const siteManifest = JSON.parse(fs.readFileSync(path.join(siteRoot, 'manifest.json'), 'utf8'));
const homeRoute = siteManifest.routes['/'];
const homeDocument = fs.readFileSync(path.join(siteRoot, homeRoute.file), 'utf8');

function outputContent(asset) {
  return fs.readFileSync(path.join(projectRoot, asset.file));
}

function gzipSize(content) {
  return gzipSync(content, { level: 9, mtime: 0 }).length;
}

const homepageJavaScript = browser.homepage.find((asset) => asset.url.endsWith('.js'));
const homepageStylesheets = browser.homepage.filter((asset) => asset.url.endsWith('.css'));
const homepageJavaScriptGzip = gzipSize(outputContent(homepageJavaScript));

assert.ok(
  homepageJavaScriptGzip <= HOMEPAGE_JS_GZIP_CEILING,
  `homepage JavaScript exceeds ${HOMEPAGE_JS_GZIP_CEILING} bytes: ${homepageJavaScriptGzip}`,
);

const criticalTransfers = new Map();
criticalTransfers.set('/', fs.statSync(path.join(siteRoot, homeRoute.gzipFile)).size);
criticalTransfers.set(homepageJavaScript.url, homepageJavaScriptGzip);
homepageStylesheets.forEach((asset) => {
  criticalTransfers.set(asset.url, gzipSize(outputContent(asset)));
});
for (const logicalPath of [
  '/global.css',
  '/images/header-logo.svg',
  '/service-worker.js',
]) {
  criticalTransfers.set(
    logicalPath,
    gzipSize(fs.readFileSync(path.join(projectRoot, `public${logicalPath}`))),
  );
}
for (const logicalPath of [
  '/images/favicon.png',
  '/images/carousel-thumbnail-placeholders.webp',
]) {
  criticalTransfers.set(
    logicalPath,
    fs.statSync(path.join(projectRoot, `public${logicalPath}`)).size,
  );
}
Object.values(homepageImages.artwork).forEach((asset) => {
  criticalTransfers.set(asset.url, asset.size);
});
Object.keys(homepageImages.covers)
  .map(Number)
  .sort((left, right) => right - left)
  .slice(0, 5)
  .forEach((issue) => {
    const asset = homepageImages.covers[issue].avif.find((candidate) => candidate.width === 180);
    criticalTransfers.set(asset.url, asset.size);
  });

const homepageTransfer = Array.from(criticalTransfers.values())
  .reduce((total, bytes) => total + bytes, 0);
assert.ok(
  homepageTransfer <= HOMEPAGE_TRANSFER_CEILING,
  `homepage cold transfer exceeds ${HOMEPAGE_TRANSFER_CEILING} bytes: ${homepageTransfer}`,
);

const filesByLogicalPath = new Map(shellAssetEntries);
allHomepageImageAssets(homepageImages).forEach((asset) => {
  filesByLogicalPath.set(asset.url, asset.file);
});
const criticalPaths = new Set(criticalTransfers.keys());
let uniqueInstallOverhead = 0;
shell.groups.homepage.forEach((url) => {
  const pathname = new URL(url, 'https://galatadergisi.org').pathname;
  if (criticalPaths.has(pathname)) return;
  const relativeFile = filesByLogicalPath.get(pathname);
  if (!relativeFile) throw new Error(`Cannot measure install asset: ${pathname}`);
  uniqueInstallOverhead += fs.statSync(path.join(projectRoot, relativeFile)).size;
});
assert.ok(
  uniqueInstallOverhead <= INSTALL_OVERHEAD_CEILING,
  `unique service-worker install overhead exceeds ${INSTALL_OVERHEAD_CEILING} bytes: ${uniqueInstallOverhead}`,
);

shell.groups.contribution.forEach((url) => {
  const pathname = new URL(url, 'https://galatadergisi.org').pathname;
  assert.equal(homeDocument.includes(pathname), false, `homepage references contribution asset: ${pathname}`);
});

const templates = [
  'client/pages/homepage/index.html',
  'client/pages/contribute/katkida-bulunun.html',
].map((filename) => fs.readFileSync(path.join(projectRoot, filename), 'utf8')).join('\n');
assert.doesNotMatch(templates, /googletag|google-analytics|fonts\.googleapis/i);

console.log([
  `Homepage cold transfer: ${homepageTransfer} / ${HOMEPAGE_TRANSFER_CEILING} bytes`,
  `Unique install overhead: ${uniqueInstallOverhead} / ${INSTALL_OVERHEAD_CEILING} bytes`,
  `Homepage JavaScript gzip: ${homepageJavaScriptGzip} / ${HOMEPAGE_JS_GZIP_CEILING} bytes`,
].join('\n'));
