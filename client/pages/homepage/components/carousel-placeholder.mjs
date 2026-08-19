// Copyright 2026 Mehmet Baker
//
// Geometry for the generated low-quality carousel placeholder sprite.

export const CAROUSEL_PLACEHOLDER_URL =
  '/images/carousel-thumbnail-placeholders.webp';
export const CAROUSEL_PLACEHOLDER_ISSUE_COUNT = 47;

export const CAROUSEL_PLACEHOLDER_GEOMETRY = Object.freeze({
  columnCount: 10,
  cellWidth: 26,
  cellHeight: 33,
  gutterSize: 4,
  placeholderWidth: 18,
  placeholderHeight: 25,
});

const {
  columnCount,
  cellHeight,
  cellWidth,
  gutterSize,
  placeholderHeight,
  placeholderWidth,
} = CAROUSEL_PLACEHOLDER_GEOMETRY;
const RENDERED_WIDTH = 100;
const RENDERED_HEIGHT = 140;

export function getCarouselPlaceholderPosition(issueIndex) {
  const normalizedIndex = Number(issueIndex);
  if (
    !Number.isInteger(normalizedIndex)
    || normalizedIndex < 1
    || normalizedIndex > CAROUSEL_PLACEHOLDER_ISSUE_COUNT
  ) {
    return null;
  }

  const spriteIndex = normalizedIndex - 1;
  const column = spriteIndex % columnCount;
  const row = Math.floor(spriteIndex / columnCount);

  return {
    x: -((column * cellWidth + gutterSize) * RENDERED_WIDTH
      / placeholderWidth),
    y: -((row * cellHeight + gutterSize) * RENDERED_HEIGHT
      / placeholderHeight),
  };
}
