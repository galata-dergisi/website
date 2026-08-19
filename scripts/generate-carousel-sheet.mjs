import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

import {
  CAROUSEL_PLACEHOLDER_GEOMETRY,
  CAROUSEL_PLACEHOLDER_ISSUE_COUNT,
} from '../client/pages/homepage/components/carousel-placeholder.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const imagesDirectory = path.join(projectRoot, 'client', 'images');
const defaultOutputPath = path.join(
  imagesDirectory,
  'carousel-thumbnail-placeholders.webp',
);

const {
  columnCount,
  cellHeight,
  cellWidth,
  gutterSize,
  placeholderHeight,
  placeholderWidth,
} = CAROUSEL_PLACEHOLDER_GEOMETRY;

function resolveThumbnailDirectory(environment) {
  const candidates = [
    environment.GALATA_STATIC_ASSETS_ROOT
      ? path.resolve(projectRoot, environment.GALATA_STATIC_ASSETS_ROOT)
      : null,
    path.resolve(
      projectRoot,
      '..',
      'galata-dergisi-static-assets',
      'server-assets',
      'public',
      'images',
    ),
    imagesDirectory,
  ].filter(Boolean);

  return candidates.find((candidate) => (
    fs.existsSync(path.join(candidate, 'sayi1', 'thumbnail.jpg'))
  ));
}

function getThumbnailPath(thumbnailDirectory, issueIndex) {
  return path.join(thumbnailDirectory, `sayi${issueIndex}`, 'thumbnail.jpg');
}

async function createPlaceholder(thumbnailPath) {
  return sharp(thumbnailPath)
    .rotate()
    .resize(placeholderWidth, placeholderHeight, { fit: 'fill' })
    .flatten({ background: '#000000' })
    .png()
    .toBuffer();
}

async function writeIfChanged(filePath, content) {
  const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  if (previous && previous.equals(content)) return false;

  fs.writeFileSync(filePath, content);
  return true;
}

export async function generateCarouselSheet({
  environment = process.env,
  outputPath = defaultOutputPath,
} = {}) {
  const thumbnailDirectory = resolveThumbnailDirectory(environment);
  if (!thumbnailDirectory) {
    throw new Error(
      'Canonical carousel thumbnails are missing. '
      + 'Set GALATA_STATIC_ASSETS_ROOT to the external images directory.',
    );
  }
  const rowCount = Math.ceil(CAROUSEL_PLACEHOLDER_ISSUE_COUNT / columnCount);
  const composites = await Promise.all(
    Array.from(
      { length: CAROUSEL_PLACEHOLDER_ISSUE_COUNT },
      async (_, spriteIndex) => {
        const issueIndex = spriteIndex + 1;
        const thumbnailPath = getThumbnailPath(thumbnailDirectory, issueIndex);
        if (!fs.existsSync(thumbnailPath)) {
          throw new Error(`Missing carousel thumbnail: ${thumbnailPath}`);
        }

        return {
          input: await createPlaceholder(thumbnailPath),
          left: (spriteIndex % columnCount) * cellWidth + gutterSize,
          top: Math.floor(spriteIndex / columnCount) * cellHeight + gutterSize,
        };
      },
    ),
  );

  const sheet = await sharp({
    create: {
      width: columnCount * cellWidth,
      height: rowCount * cellHeight,
      channels: 3,
      background: '#000000',
    },
  })
    .composite(composites)
    .webp({ effort: 6, quality: 35, smartSubsample: true })
    .toBuffer();

  const changed = await writeIfChanged(outputPath, sheet);
  process.stdout.write(
    `${changed ? 'Generated' : 'Carousel sheet is current:'} ${path.relative(projectRoot, outputPath)}\n`,
  );

  return { changed, outputPath, sheet };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateCarouselSheet().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
