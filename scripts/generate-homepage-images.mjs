#!/usr/bin/env node

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const sourceRoot = path.join(projectRoot, 'client', 'images');
const externalSourceCandidates = [
  process.env.GALATA_STATIC_ASSETS_ROOT
    ? path.resolve(projectRoot, process.env.GALATA_STATIC_ASSETS_ROOT)
    : null,
  path.resolve(projectRoot, '..', 'galata-dergisi-static-assets', 'server-assets', 'public', 'images'),
  sourceRoot,
].filter(Boolean);
const coverSourceRoot = externalSourceCandidates.find((candidate) => (
  fs.existsSync(path.join(candidate, 'sayi1', 'thumbnail.jpg'))
));
const publicRoot = path.join(projectRoot, 'public');
const outputRoot = path.join(publicRoot, 'images', 'homepage-covers');
const manifestPath = path.join(projectRoot, 'build', 'homepage-images.json');

const AVIF_OPTIONS = Object.freeze({ effort: 7, quality: 50 });
const COVER_SIZES = Object.freeze([
  Object.freeze({ width: 100, height: 140 }),
  Object.freeze({ width: 180, height: 252 }),
]);
const ARTWORK = Object.freeze({
  firstShelf: 'first-shelf.png',
  headerLogo: 'header-logo.jpg',
  wallBookshelf: 'wall-bookshelf.png',
});

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function compareCodepoint(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function writeIfChanged(filename, content) {
  const previous = fs.existsSync(filename) ? fs.readFileSync(filename) : null;
  if (previous && previous.equals(content)) return false;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
  return true;
}

function removeObsoleteFiles(keptFiles) {
  if (!fs.existsSync(outputRoot)) return;
  fs.readdirSync(outputRoot).forEach((entry) => {
    const filename = path.join(outputRoot, entry);
    if (fs.statSync(filename).isFile() && !keptFiles.has(entry)) {
      fs.rmSync(filename);
    }
  });
}

function assetRecord(filename, content, metadata) {
  const sha256 = digest(content);
  const basename = `${filename}.${sha256.slice(0, 16)}.avif`;
  const absoluteFile = path.join(outputRoot, basename);
  writeIfChanged(absoluteFile, content);
  return {
    contentType: 'image/avif',
    file: path.relative(projectRoot, absoluteFile).split(path.sep).join('/'),
    height: metadata.height,
    sha256,
    size: content.length,
    url: `/images/homepage-covers/${basename}`,
    width: metadata.width,
  };
}

async function generateArtwork(name, sourceFilename) {
  const source = path.join(sourceRoot, sourceFilename);
  const metadata = await sharp(source).metadata();
  const content = await sharp(source)
    .rotate()
    .avif(AVIF_OPTIONS)
    .toBuffer();
  return assetRecord(`art-${name.toLocaleLowerCase('en-US')}`, content, {
    height: metadata.height,
    width: metadata.width,
  });
}

async function generateCover(issue, size) {
  const source = path.join(coverSourceRoot, `sayi${issue}`, 'thumbnail.jpg');
  if (!fs.existsSync(source)) {
    throw new Error(`Missing homepage cover source: ${source}`);
  }
  const content = await sharp(source)
    .rotate()
    .resize({
      fit: 'cover',
      height: size.height,
      position: 'centre',
      width: size.width,
    })
    .avif(AVIF_OPTIONS)
    .toBuffer();
  return assetRecord(`sayi${issue}-${size.width}`, content, size);
}

function stableManifest(manifest) {
  return {
    ...manifest,
    artwork: Object.fromEntries(
      Object.entries(manifest.artwork).sort(([left], [right]) => compareCodepoint(left, right)),
    ),
    covers: Object.fromEntries(
      Object.entries(manifest.covers)
        .sort(([left], [right]) => Number(left) - Number(right)),
    ),
  };
}

export async function generateHomepageImages() {
  if (!coverSourceRoot) {
    throw new Error(
      'Canonical cover sources are missing. Set GALATA_STATIC_ASSETS_ROOT to the external images directory.',
    );
  }
  fs.mkdirSync(outputRoot, { recursive: true });
  const issueDirectories = fs.readdirSync(coverSourceRoot)
    .map((entry) => /^sayi([1-9][0-9]*)$/.exec(entry))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter((issue) => fs.existsSync(path.join(coverSourceRoot, `sayi${issue}`, 'thumbnail.jpg')))
    .sort((left, right) => left - right);
  if (issueDirectories.length === 0) {
    throw new Error('No homepage cover sources were found.');
  }

  const artwork = {};
  for (const [name, sourceFilename] of Object.entries(ARTWORK)) {
    artwork[name] = await generateArtwork(name, sourceFilename);
  }

  const covers = {};
  for (const issue of issueDirectories) {
    covers[issue] = {
      avif: [],
      fallback: `/images/sayi${issue}/thumbnail.jpg`,
    };
    for (const size of COVER_SIZES) {
      covers[issue].avif.push(await generateCover(issue, size));
    }
  }

  const manifest = stableManifest({
    artwork,
    covers,
    format: 'avif',
    settings: {
      coverSizes: COVER_SIZES,
      effort: AVIF_OPTIONS.effort,
      fit: 'cover',
      quality: AVIF_OPTIONS.quality,
    },
    version: 1,
  });
  const keptFiles = new Set([
    ...Object.values(artwork).map((asset) => path.basename(asset.file)),
    ...Object.values(covers).flatMap((cover) => (
      cover.avif.map((asset) => path.basename(asset.file))
    )),
  ]);
  removeObsoleteFiles(keptFiles);
  const serialized = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeIfChanged(manifestPath, serialized);
  process.stdout.write(
    `Generated ${issueDirectories.length * COVER_SIZES.length} homepage covers and `
      + `${Object.keys(artwork).length} artwork assets.\n`,
  );
  return { manifest, manifestPath, outputRoot };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateHomepageImages().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
