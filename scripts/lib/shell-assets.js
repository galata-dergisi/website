// Copyright 2026 Mehmet Baker
//
// Deterministic release assets grouped by when the browser needs them. Stable
// public paths keep query versions; Vite and generated AVIF paths are already
// content hashed and remain unchanged.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readBrowserAssetManifest } = require('./browser-assets.js');
const {
  allHomepageImageAssets,
  readHomepageImageManifest,
} = require('./homepage-images.js');

const MANIFEST_VERSION = 2;
const VERSION_LENGTH = 16;
const MANIFEST_RELATIVE_PATH = 'build/shell-assets.json';

const shellAssetEntries = [
  ['/bundle.css', 'public/bundle.css'],
  ['/bundle.js', 'public/bundle.js'],
  ['/global.css', 'public/global.css'],
  ['/katkida-bulunun/bundle.css', 'public/katkida-bulunun/bundle.css'],
  ['/katkida-bulunun/bundle.js', 'public/katkida-bulunun/bundle.js'],
  ['/fonts/akaDora.woff2', 'public/fonts/akaDora.woff2'],
  ['/images/carousel-thumbnail-placeholders.webp', 'public/images/carousel-thumbnail-placeholders.webp'],
  ['/images/favicon.png', 'public/images/favicon.png'],
  ['/images/bant.jpg', 'public/images/bant.jpg'],
  ['/images/first-shelf.png', 'public/images/first-shelf.png'],
  ['/images/header-logo.jpg', 'public/images/header-logo.jpg'],
  ['/images/wall-bookshelf.png', 'public/images/wall-bookshelf.png'],
];

const textAssetPaths = new Set([
  '/bundle.css',
  '/bundle.js',
  '/global.css',
  '/katkida-bulunun/bundle.css',
  '/katkida-bulunun/bundle.js',
]);

const unversionedAssetPaths = new Set([
  '/fonts/akaDora.woff2',
  '/images/bant.jpg',
]);

const readerLeafPaths = [
  '/fonts/akaDora.woff2',
  '/images/bant.jpg',
];

function compareCodepoint(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function versionedURL(logicalPath, sha256) {
  return `${logicalPath}?v=${sha256.slice(0, VERSION_LENGTH)}`;
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function referenceAliases(logicalPath) {
  const aliases = [logicalPath];
  if (logicalPath.startsWith('/fonts/')) {
    aliases.push(`../fonts/${logicalPath.slice('/fonts/'.length)}`);
  }
  return aliases;
}

function replaceReference(source, logicalPath, replacement) {
  let result = source;
  referenceAliases(logicalPath).forEach((alias) => {
    const pattern = new RegExp(
      `${escapeRegularExpression(alias)}(?:\\?v=[a-f0-9]{${VERSION_LENGTH},64})?`,
      'g',
    );
    result = result.replace(pattern, replacement);
  });
  return result;
}

function manifestFile(projectRoot) {
  return path.join(projectRoot, MANIFEST_RELATIVE_PATH);
}

function missingShellAssetFiles(projectRoot) {
  return shellAssetEntries
    .map(([, relativeFile]) => relativeFile)
    .filter((relativeFile) => !fs.existsSync(path.join(projectRoot, relativeFile)));
}

function manifestEntry(logicalPath, content, { immutable = false, version = null } = {}) {
  const sha256 = digest(content);
  return {
    digest: sha256,
    immutable,
    url: immutable || unversionedAssetPaths.has(logicalPath)
      ? logicalPath
      : versionedURL(logicalPath, version || sha256),
  };
}

function stableManifest(assets, groups) {
  return {
    version: MANIFEST_VERSION,
    algorithm: 'sha256',
    assets: Object.fromEntries(
      Object.entries(assets).sort(([left], [right]) => compareCodepoint(left, right)),
    ),
    groups: Object.fromEntries(
      Object.entries(groups).sort(([left], [right]) => compareCodepoint(left, right)),
    ),
  };
}

function validateShellAssetManifest(manifest) {
  if (
    !manifest
    || manifest.version !== MANIFEST_VERSION
    || manifest.algorithm !== 'sha256'
    || !manifest.assets
    || !manifest.groups
  ) {
    throw new Error('Shell asset manifest is invalid. Run the client build again.');
  }
  const groupNames = Object.keys(manifest.groups).sort(compareCodepoint);
  if (JSON.stringify(groupNames) !== JSON.stringify(['contribution', 'homepage', 'reader'])) {
    throw new Error('Shell asset manifest groups are invalid.');
  }
  Object.entries(manifest.assets).forEach(([logicalPath, entry]) => {
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.digest) || typeof entry.url !== 'string') {
      throw new Error(`Shell asset entry is invalid: ${logicalPath}`);
    }
  });
  Object.entries(manifest.groups).forEach(([name, urls]) => {
    if (!Array.isArray(urls) || urls.some((url) => (
      !Object.values(manifest.assets).some((asset) => asset.url === url)
    ))) {
      throw new Error(`Shell asset group is invalid: ${name}`);
    }
  });
  return manifest;
}

function createShellAssetManifest(projectRoot) {
  const missingFiles = missingShellAssetFiles(projectRoot);
  if (missingFiles.length > 0) {
    throw new Error(`Missing shell assets:\n${missingFiles.join('\n')}`);
  }

  const browser = readBrowserAssetManifest(projectRoot);
  const homepageImages = readHomepageImageManifest(projectRoot);
  const generatedImages = allHomepageImageAssets(homepageImages);
  const assets = {};
  const leafAssetEntries = shellAssetEntries.filter(
    ([logicalPath]) => !textAssetPaths.has(logicalPath),
  );
  const textAssetEntries = shellAssetEntries.filter(
    ([logicalPath]) => textAssetPaths.has(logicalPath),
  );
  leafAssetEntries.forEach(([logicalPath, relativeFile]) => {
    assets[logicalPath] = manifestEntry(
      logicalPath,
      fs.readFileSync(path.join(projectRoot, relativeFile)),
    );
  });
  textAssetEntries.forEach(([logicalPath, relativeFile]) => {
    const filename = path.join(projectRoot, relativeFile);
    const original = fs.readFileSync(filename, 'utf8');
    const rewritten = leafAssetEntries.reduce(
      (source, [leafPath]) => replaceReference(
        source,
        leafPath,
        assets[leafPath].url,
      ),
      original,
    );
    if (rewritten !== original) fs.writeFileSync(filename, rewritten);
    assets[logicalPath] = manifestEntry(
      logicalPath,
      Buffer.from(rewritten),
    );
  });
  browser.homepage.forEach((asset) => {
    if (assets[asset.url]) return;
    assets[asset.url] = manifestEntry(
      asset.url,
      fs.readFileSync(path.join(projectRoot, asset.file)),
      { immutable: true },
    );
  });
  generatedImages.forEach((asset) => {
    assets[asset.url] = manifestEntry(
      asset.url,
      fs.readFileSync(path.join(projectRoot, asset.file)),
      { immutable: true },
    );
  });

  const resolve = (logicalPath) => assets[logicalPath].url;
  const groups = {
    homepage: [
      resolve('/bundle.js'),
      resolve('/bundle.css'),
      resolve('/global.css'),
      resolve('/images/favicon.png'),
      resolve('/images/carousel-thumbnail-placeholders.webp'),
      ...Object.values(homepageImages.artwork).map((asset) => resolve(asset.url)),
    ],
    reader: readerLeafPaths.map(resolve),
    contribution: [
      resolve('/katkida-bulunun/bundle.js'),
      resolve('/katkida-bulunun/bundle.css'),
    ],
  };

  const manifest = stableManifest(assets, groups);
  validateShellAssetManifest(manifest);
  const filename = manifestFile(projectRoot);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const previous = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : null;
  if (previous !== serialized) fs.writeFileSync(filename, serialized);
  return manifest;
}

function readShellAssetManifest(projectRoot) {
  const filename = manifestFile(projectRoot);
  if (!fs.existsSync(filename)) {
    throw new Error('Shell asset manifest is missing. Run the client build first.');
  }
  return validateShellAssetManifest(JSON.parse(fs.readFileSync(filename, 'utf8')));
}

function applyShellAssetVersions(source, manifest) {
  const validManifest = validateShellAssetManifest(manifest);
  return shellAssetEntries.reduce(
    (result, [logicalPath]) => replaceReference(
      result,
      logicalPath,
      validManifest.assets[logicalPath].url,
    ),
    String(source),
  );
}

function versionShellAssetPath(logicalPath, manifest) {
  const validManifest = validateShellAssetManifest(manifest);
  const entry = validManifest.assets[logicalPath];
  return entry ? entry.url : logicalPath;
}

module.exports = {
  MANIFEST_RELATIVE_PATH,
  applyShellAssetVersions,
  createShellAssetManifest,
  digest,
  manifestFile,
  missingShellAssetFiles,
  readerLeafPaths,
  readShellAssetManifest,
  shellAssetEntries,
  validateShellAssetManifest,
  versionShellAssetPath,
};
