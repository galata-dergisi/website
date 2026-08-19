// Copyright 2026 Mehmet Baker
//
// Pure carousel state and window calculations shared by the browser component
// and the Node test suite.

export const VISIBLE_ITEM_COUNT = 3;
export const ITEM_STEP = 150;
export const TRANSITION_TIMEOUT = 350;

function itemCount(value) {
  return Array.isArray(value) ? value.length : Math.max(0, Number(value) || 0);
}

export function maximumFirstItemIndex(value) {
  return Math.max(0, itemCount(value) - VISIBLE_ITEM_COUNT);
}

export function clampFirstItemIndex(index, value) {
  const normalizedIndex = Number.isFinite(index) ? Math.trunc(index) : 0;
  return Math.min(Math.max(0, normalizedIndex), maximumFirstItemIndex(value));
}

export function clampFirstItemPosition(position, value) {
  const normalizedPosition = Number.isFinite(position) ? position : 0;
  return Math.min(
    Math.max(0, normalizedPosition),
    maximumFirstItemIndex(value),
  );
}

export function createCarouselState(value) {
  const targetFirstItemIndex = clampFirstItemIndex(0, value);
  return {
    sourceFirstItemPosition: targetFirstItemIndex,
    targetFirstItemIndex,
    animating: false,
  };
}

export function reconcileCarouselState(state, value) {
  const targetFirstItemIndex = clampFirstItemIndex(
    state.targetFirstItemIndex,
    value,
  );
  return {
    sourceFirstItemPosition: targetFirstItemIndex,
    targetFirstItemIndex,
    animating: false,
  };
}

export function rebaseCarouselMove(state, sourceFirstItemPosition, value) {
  const sourcePosition = clampFirstItemPosition(sourceFirstItemPosition, value);
  const targetFirstItemIndex = clampFirstItemIndex(
    state.targetFirstItemIndex,
    value,
  );
  return {
    sourceFirstItemPosition: sourcePosition,
    targetFirstItemIndex,
    animating: sourcePosition !== targetFirstItemIndex,
  };
}

export function beginCarouselMove(
  state,
  direction,
  sourceFirstItemPosition,
  value,
) {
  if (direction !== -1 && direction !== 1) return state;

  const targetFirstItemIndex = clampFirstItemIndex(
    state.targetFirstItemIndex + direction,
    value,
  );

  if (targetFirstItemIndex === state.targetFirstItemIndex) return state;

  return rebaseCarouselMove(
    { ...state, targetFirstItemIndex },
    sourceFirstItemPosition,
    value,
  );
}

export function finishCarouselMove(state, value) {
  const targetFirstItemIndex = clampFirstItemIndex(
    state.targetFirstItemIndex,
    value,
  );
  return {
    sourceFirstItemPosition: targetFirstItemIndex,
    targetFirstItemIndex,
    animating: false,
  };
}

export function getCarouselWindow(items, state, buffered = false) {
  const carouselItems = Array.isArray(items) ? items : [];
  const length = carouselItems.length;

  if (length === 0) return { startIndex: 0, entries: [] };

  const targetFirstItemIndex = clampFirstItemIndex(
    state.targetFirstItemIndex,
    length,
  );
  const sourceFirstItemPosition = state.animating
    ? clampFirstItemPosition(state.sourceFirstItemPosition, length)
    : targetFirstItemIndex;
  const pathStartIndex = Math.floor(Math.min(
    sourceFirstItemPosition,
    targetFirstItemIndex,
  ));
  const pathEndIndex = Math.min(
    length - 1,
    Math.ceil(Math.max(sourceFirstItemPosition, targetFirstItemIndex))
      + VISIBLE_ITEM_COUNT - 1,
  );
  const sourceStartIndex = Math.floor(sourceFirstItemPosition);
  const sourceEndIndex = Math.min(
    length - 1,
    Math.ceil(sourceFirstItemPosition) + VISIBLE_ITEM_COUNT - 1,
  );
  const targetEndIndex = Math.min(
    length - 1,
    targetFirstItemIndex + VISIBLE_ITEM_COUNT - 1,
  );
  const startIndex = buffered ? Math.max(0, pathStartIndex - 1) : pathStartIndex;
  const endIndex = buffered
    ? Math.min(length - 1, pathEndIndex + 1)
    : pathEndIndex;

  const entries = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const sourceVisible = index >= sourceStartIndex && index <= sourceEndIndex;
    const targetVisible = index >= targetFirstItemIndex && index <= targetEndIndex;
    entries.push({
      item: carouselItems[index],
      index,
      visible: index >= pathStartIndex && index <= pathEndIndex,
      motion: sourceVisible && !targetVisible
        ? 'out'
        : !sourceVisible && targetVisible ? 'in' : null,
    });
  }

  return { startIndex, entries };
}
