import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';

import sharp from 'sharp';

import { generateCarouselSheet } from '../scripts/generate-carousel-sheet.mjs';
import {
  CAROUSEL_PLACEHOLDER_GEOMETRY,
  CAROUSEL_PLACEHOLDER_ISSUE_COUNT,
} from '../client/pages/homepage/components/carousel-placeholder.mjs';

test('carousel sheet reads thumbnails from GALATA_STATIC_ASSETS_ROOT', async (context) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'galata-carousel-sheet-'));
  context.after(() => fs.rmSync(temporaryRoot, { force: true, recursive: true }));

  const thumbnail = await sharp({
    create: {
      background: '#ffffff',
      channels: 3,
      height: 25,
      width: 18,
    },
  }).jpeg().toBuffer();
  const sourceRoot = path.join(temporaryRoot, 'external-images');
  for (let issue = 1; issue <= CAROUSEL_PLACEHOLDER_ISSUE_COUNT; issue += 1) {
    const issueRoot = path.join(sourceRoot, `sayi${issue}`);
    fs.mkdirSync(issueRoot, { recursive: true });
    fs.writeFileSync(path.join(issueRoot, 'thumbnail.jpg'), thumbnail);
  }

  const outputPath = path.join(temporaryRoot, 'carousel.webp');
  const result = await generateCarouselSheet({
    environment: { GALATA_STATIC_ASSETS_ROOT: sourceRoot },
    outputPath,
  });
  const metadata = await sharp(outputPath).metadata();

  assert.equal(result.outputPath, outputPath);
  assert.equal(metadata.width, CAROUSEL_PLACEHOLDER_GEOMETRY.columnCount
    * CAROUSEL_PLACEHOLDER_GEOMETRY.cellWidth);
  assert.equal(metadata.height, Math.ceil(
    CAROUSEL_PLACEHOLDER_ISSUE_COUNT / CAROUSEL_PLACEHOLDER_GEOMETRY.columnCount,
  ) * CAROUSEL_PLACEHOLDER_GEOMETRY.cellHeight);
});
