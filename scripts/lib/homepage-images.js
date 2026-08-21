const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_RELATIVE_PATH = 'build/homepage-images.json';

function manifestPath(projectRoot) {
  return path.join(projectRoot, MANIFEST_RELATIVE_PATH);
}

function validateAsset(projectRoot, asset, description) {
  if (
    !asset
    || asset.contentType !== 'image/avif'
    || !/^\/images\/homepage-covers\/[a-z0-9-]+\.[a-f0-9]{16}\.avif$/.test(asset.url)
    || !/^[a-f0-9]{64}$/.test(asset.sha256)
    || !Number.isInteger(asset.width)
    || !Number.isInteger(asset.height)
    || !Number.isInteger(asset.size)
  ) {
    throw new Error(`Invalid generated homepage image: ${description}`);
  }
  const filename = path.resolve(projectRoot, asset.file);
  if (!filename.startsWith(`${path.resolve(projectRoot)}${path.sep}`)) {
    throw new Error(`Homepage image escapes project root: ${description}`);
  }
  const content = fs.readFileSync(filename);
  if (content.length !== asset.size) {
    throw new Error(`Homepage image size mismatch: ${description}`);
  }
  if (crypto.createHash('sha256').update(content).digest('hex') !== asset.sha256) {
    throw new Error(`Homepage image digest mismatch: ${description}`);
  }
}

function readHomepageImageManifest(projectRoot) {
  const filename = manifestPath(projectRoot);
  if (!fs.existsSync(filename)) {
    throw new Error('Homepage image manifest is missing. Run the homepage image generator.');
  }
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!manifest || manifest.version !== 1 || manifest.format !== 'avif') {
    throw new Error('Homepage image manifest is invalid.');
  }
  Object.entries(manifest.artwork || {}).forEach(([name, asset]) => {
    validateAsset(projectRoot, asset, `artwork ${name}`);
  });
  Object.entries(manifest.covers || {}).forEach(([issue, cover]) => {
    if (!Array.isArray(cover.avif) || cover.avif.length !== 2) {
      throw new Error(`Invalid generated homepage cover: issue ${issue}`);
    }
    cover.avif.forEach((asset) => validateAsset(projectRoot, asset, `issue ${issue}`));
  });
  return manifest;
}

function allHomepageImageAssets(manifest) {
  return [
    ...Object.values(manifest.artwork || {}),
    ...Object.values(manifest.covers || {}).flatMap((cover) => cover.avif),
  ];
}

function homepageArtworkSources(manifest) {
  const artwork = manifest.artwork || {};
  const source = (name, fallback) => {
    const asset = artwork[name];
    return asset ? {
      avif: asset.url,
      fallback,
      height: asset.height,
      width: asset.width,
    } : {
      avif: '',
      fallback,
      height: null,
      width: null,
    };
  };
  return {
    firstShelf: source('firstShelf', '/images/first-shelf.png'),
    headerLogo: source('headerLogo', '/images/header-logo.svg'),
    wallBookshelf: source('wallBookshelf', '/images/wall-bookshelf.png'),
  };
}

module.exports = {
  MANIFEST_RELATIVE_PATH,
  allHomepageImageAssets,
  homepageArtworkSources,
  manifestPath,
  readHomepageImageManifest,
};
