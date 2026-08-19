/**
 * Geometry helpers derived from Turn.js 3rd release (www.turnjs.com).
 * Copyright (C) 2012, Emmanuel Garcia. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted only when the copyright notice and conditions
 * are retained and the work is used solely for personal, noncommercial
 * benefit. See LICENSE for the complete license and disclaimer.
 */

function point(x, y) {
  return { x, y };
}

export function pageTurnBezier(p1, p2, p3, p4, t) {
  const inverse = 1 - t;
  const inverseCubed = inverse * inverse * inverse;
  const tCubed = t * t * t;
  return point(
    Math.round(inverseCubed * p1.x + 3 * t * inverse * inverse * p2.x + 3 * t * t * inverse * p3.x + tCubed * p4.x),
    Math.round(inverseCubed * p1.y + 3 * t * inverse * inverse * p2.y + 3 * t * t * inverse * p3.y + tCubed * p4.y),
  );
}

export function pageTurnEasing(time, begin, change, duration) {
  const normalized = time / duration - 1;
  return change * Math.sqrt(1 - normalized * normalized) + begin;
}

export function pageTurnView(page) {
  return page % 2 ? [page - 1, page] : [page, page + 1];
}

export function pageTurnRange(page, totalPages, pagesInDom) {
  const view = pageTurnView(page);
  let left;
  let right;

  if (view[0] >= 1 && view[1] <= totalPages) {
    const remainingPages = Math.floor((pagesInDom - 2) / 2);
    if (totalPages - view[1] > view[0]) {
      left = Math.min(view[0] - 1, remainingPages);
      right = 2 * remainingPages - left;
    } else {
      right = Math.min(totalPages - view[1], remainingPages);
      left = 2 * remainingPages - right;
    }
  } else {
    left = pagesInDom - 1;
    right = pagesInDom - 1;
  }

  return [Math.max(1, view[0] - left), Math.min(totalPages, view[1] + right)];
}

export function pageTurnStacking(movingPages, totalPages, currentView, nextPages, pagePlaces) {
  const currentPage = currentView[0] || currentView[1];
  const result = { pageZ: {}, partZ: {}, pageV: {}};
  const addView = (page) => {
    const view = pageTurnView(page);
    if (view[0] > 0 && view[0] <= totalPages) result.pageV[view[0]] = true;
    if (view[1] > 0 && view[1] <= totalPages) result.pageV[view[1]] = true;
  };

  for (const page of movingPages) {
    const nextPage = nextPages[page];
    const placePage = pagePlaces[page];
    addView(page);
    addView(nextPage);
    const displayPage = pagePlaces[nextPage] == nextPage ? nextPage : page;
    result.pageZ[displayPage] = totalPages - Math.abs(currentPage - displayPage);
    result.partZ[placePage] = totalPages * 2 + Math.abs(currentPage - displayPage);
  }

  return result;
}
