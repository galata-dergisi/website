/**
 * Native Galata page-turn engine, derived from Turn.js 3rd release.
 *
 * The original folding geometry, timing, and gradients are retained while
 * the jQuery integration is replaced with private native DOM primitives.
 * PageTurn is the only supported application API; pure geometry helpers live
 * in the companion module for deterministic tests.
 *
 * turn.js 3rd release
 * www.turnjs.com
 *
 * Copyright (C) 2012, Emmanuel Garcia.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1. Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *
 * 2. Any redistribution, use, or modification is done solely for personal
 * benefit and not for any commercial purpose or for monetary gain.
 *
 **/

import { pageTurnBezier, pageTurnEasing, pageTurnRange, pageTurnView } from './page-turn-math.mjs';

const elementData = new WeakMap();
const elementEvents = new WeakMap();
const isTouch = typeof window !== 'undefined' && 'ontouchstart' in window;
const gestureBoundarySelector = '[data-page-turn-gesture-boundary]';

function isWithinGestureBoundary(event, root) {
  const target = event?.originalEvent?.target;
  const boundary = target && typeof target.closest === 'function'
    ? target.closest(gestureBoundarySelector)
    : null;
  return Boolean(boundary && root.contains(boundary));
}

function hasActivePointer(event) {
  const originalEvent = event?.originalEvent;
  return isTouch
    ? Boolean(originalEvent?.touches?.length)
    : Boolean(originalEvent?.buttons);
}


class PageTurnEvent {
  constructor(type, originalEvent) {
    this.type = type;
    this.originalEvent = originalEvent;
    this.pageX = originalEvent && originalEvent.pageX;
    this.pageY = originalEvent && originalEvent.pageY;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

}

class DomSet {
  constructor(elements = []) {
    this.length = elements.length;
    for (let index = 0; index < elements.length; index += 1) this[index] = elements[index];
  }

  each(callback) {
    for (let index = 0; index < this.length; index += 1) callback(this[index]);
    return this;
  }

  data() {
    const element = this[0];
    let data = elementData.get(element);
    if (!data) {
      data = {};
      elementData.set(element, data);
    }
    return data;
  }

  css(property, value) {
    if (typeof property === 'string' && value === undefined) {
      const element = this[0];
      return getComputedStyle(element).getPropertyValue(property);
    }

    const properties = typeof property === 'string' ? { [property]: value } : property;
    return this.each((element) => {
      for (const [name, rawValue] of Object.entries(properties || {})) {
        const cssValue = typeof rawValue === 'number' && name !== 'z-index' ? rawValue + 'px' : String(rawValue);
        element.style.setProperty(name, cssValue);
      }
    });
  }

  width() {
    return elementDimension(this[0], 'width');
  }

  height() {
    return elementDimension(this[0], 'height');
  }

  offset() {
    const rect = this[0].getBoundingClientRect();
    return { top: rect.top + window.scrollY, left: rect.left + window.scrollX };
  }

  bind(type, handler) {
    this.each((element) => bindEvent(element, type, handler));
    return this;
  }

  unbind(type, handler) {
    this.each((element) => unbindEvent(element, type, handler));
    return this;
  }

  trigger(event, args = []) {
    const turnEvent = typeof event === 'string' ? new PageTurnEvent(event) : event;
    this.each((element) => {
      const eventMap = elementEvents.get(element);
      const record = eventMap && eventMap.get(turnEvent.type);
      if (record) {
        const result = record.handler.call(element, turnEvent, ...args);
        if (result === false) {
          turnEvent.preventDefault();
        }
      }
    });
    return this;
  }

  append(child) {
    return this.each((element) => {
      for (const childElement of domElements(child)) element.append(childElement);
    });
  }

  prepend(child) {
    return this.each((element) => {
      const elements = domElements(child);
      for (let index = elements.length - 1; index >= 0; index -= 1) element.prepend(elements[index]);
    });
  }

  appendTo(parent) {
    createDomSet(parent).append(this);
    return this;
  }

  parent() {
    return new DomSet([this[0].parentElement]);
  }

  children(selector) {
    let children = Array.from(this[0].children);
    if (selector === ':first-child') children = children.slice(0, 1);
    return new DomSet(children);
  }

  remove() {
    return this.each((element) => element.remove());
  }

  addClass(names) {
    const classes = names.split(/\s+/).filter(Boolean);
    return this.each((element) => element.classList.add(...classes));
  }

  hide() {
    return this.css('display', 'none');
  }

  show() {
    return this.css('display', '');
  }

  is() {
    const element = this[0];
    return Boolean(element && getComputedStyle(element).display !== 'none' && element.getClientRects().length);
  }
}

function elementDimension(element, dimension) {
  const computed = getComputedStyle(element).getPropertyValue(dimension);
  const parsed = Number.parseFloat(computed);
  if (Number.isFinite(parsed)) return parsed;
  return element.getBoundingClientRect()[dimension];
}

function domElements(value) {
  if (value instanceof DomSet) {
    const elements = [];
    for (let index = 0; index < value.length; index += 1) elements.push(value[index]);
    return elements;
  }
  return value && value.nodeType ? [value] : [];
}

function bindEvent(element, type, handler) {
  let eventMap = elementEvents.get(element);
  if (!eventMap) {
    eventMap = new Map();
    elementEvents.set(element, eventMap);
  }
  const record = { handler, nativeHandler: null };
  if (type.startsWith('mouse') || type.startsWith('touch')) {
    record.nativeHandler = (nativeEvent) => {
      const result = handler.call(element, new PageTurnEvent(type, nativeEvent));
      if (result === false) {
        nativeEvent.preventDefault();
        nativeEvent.stopPropagation();
      }
    };
    element.addEventListener(type, record.nativeHandler, type.startsWith('touch') ? { passive: false } : false);
  }
  eventMap.set(type, record);
}

function unbindEvent(element, type, handler) {
  const eventMap = elementEvents.get(element);
  const record = eventMap && eventMap.get(type);
  if (!record || (handler && record.handler !== handler)) return;
  if (record.nativeHandler) element.removeEventListener(type, record.nativeHandler);
  eventMap.delete(type);
}

function unbindAllEvents(element) {
  const eventMap = elementEvents.get(element);
  if (!eventMap) return;
  for (const [type, record] of eventMap) {
    if (record.nativeHandler) element.removeEventListener(type, record.nativeHandler);
  }
  elementEvents.delete(element);
}

function createDomSet(input, attributes) {
  if (input instanceof DomSet) return input;
  let elements = [];
  if (typeof input === 'string') {
    const tag = input.match(/^<([a-z][\w-]*)\s*\/?>$/i);
    elements = [document.createElement(tag[1])];
  } else if ((input && input.nodeType) || input === window) elements = [input];

  const result = new DomSet(elements);
  if (attributes) {
    for (const [name, value] of Object.entries(attributes)) {
      if (name === 'class') result.addClass(value);
      else if (name === 'css') result.css(value);
      else result.each((element) => element.setAttribute(name, value));
    }
  }
  return result;
}

createDomSet.fn = DomSet.prototype;

/* eslint-disable no-unused-vars, no-plusplus, object-curly-spacing */
if (typeof document !== 'undefined') (function ($) {
  'use strict';

  var PI = Math.PI,
    A90 = PI / 2,
    events = isTouch
      ? { start: 'touchstart', move: 'touchmove', end: 'touchend', cancel: 'touchcancel' }
      : { start: 'mousedown', move: 'mousemove', end: 'mouseup' },
    // Contansts used for each corner
    // tl * tr
    // *     *
    // bl * br

    corners = {
      backward: ['bl', 'tl'],
      forward: ['br', 'tr'],
    },
    // Number of pages in the DOM, minimum value: 6

    pagesInDOM = 6,
    pagePosition = { 0: { top: 0, left: 0, right: 'auto', bottom: 'auto' }, 1: { top: 0, right: 0, left: 'auto', bottom: 'auto' } },
    // Gets basic attributes for a layer

    divAtt = function (top, left, zIndex, overf) {
      return {
        css: {
          position: 'absolute',
          top: top,
          left: left,
          overflow: overf || 'hidden',
          'z-index': zIndex || 'auto',
        },
      };
    },
    // Gets a 2D point from a bezier curve of four points

    bezier = pageTurnBezier,
    // Converts an angle from degrees to radians

    rad = function (degrees) {
      return (degrees / 180) * PI;
    },
    // Converts an angle from radians to degrees

    deg = function (radians) {
      return (radians / PI) * 180;
    },
    // Gets a 2D point

    point2D = function (x, y) {
      return { x: x, y: y };
    },
    // Returns the traslate value

    translate = function (x, y) {
      return ' translate(' + x + 'px, ' + y + 'px) ';
    },
    // Returns the rotation value

    rotate = function (degrees) {
      return ' rotate(' + degrees + 'deg) ';
    },
    // Checks if a property belongs to an object

    has = function (property, object) {
      return Object.prototype.hasOwnProperty.call(object, property);
    },
    // Adds gradients

    gradient = function (obj, p0, p1, colors) {
      var j,
        cols = [];

      if (document.body.style.WebkitTransform !== undefined) {
        for (j = 0; j < colors.length; j++) cols.push('color-stop(' + colors[j][0] + ',' + colors[j][1] + ')');
        obj.css({
          'background-image':
            '-webkit-gradient(linear,' + p0.x + '% ' + p0.y + '%,' + p1.x + '% ' + p1.y + '%,' + cols.join(',') + ')',
        });
        return;
      }

      p0 = { x: (p0.x / 100) * obj.width(), y: (p0.y / 100) * obj.height() };
      p1 = { x: (p1.x / 100) * obj.width(), y: (p1.y / 100) * obj.height() };

      var dx = p1.x - p0.x,
        dy = p1.y - p0.y,
        angle = Math.atan2(dy, dx),
        angle2 = angle - Math.PI / 2,
        diagonal = Math.abs(obj.width() * Math.sin(angle2)) + Math.abs(obj.height() * Math.cos(angle2)),
        gradientDiagonal = Math.sqrt(dy * dy + dx * dx),
        corner = point2D(p1.x < p0.x ? obj.width() : 0, p1.y < p0.y ? obj.height() : 0),
        slope = Math.tan(angle),
        inverse = -1 / slope,
        x = (inverse * corner.x - corner.y - slope * p0.x + p0.y) / (inverse - slope),
        c = { x: x, y: inverse * x - inverse * corner.x + corner.y },
        segA = Math.sqrt(Math.pow(c.x - p0.x, 2) + Math.pow(c.y - p0.y, 2));

      for (j = 0; j < colors.length; j++)
        cols.push(colors[j][1] + ' ' + ((segA + gradientDiagonal * colors[j][0]) * 100) / diagonal + '%');

      obj.css({ 'background-image': 'linear-gradient(' + -angle + 'rad,' + cols.join(',') + ')' });
    },
    turnMethods = {
      // Singleton constructor
      // $('#selector').turn([options]);

      init: function (opts) {
        var i,
          data = this.data(),
          ch = this.children(),
          root = this[0];

        data.opts = opts;
        data.pageObjs = {};
        data.pages = {};
        data.pageWrap = {};
        data.pagePlace = {};
        data.pageMv = [];
        data.totalPages = opts.pages || 0;
        data.shadowElement = null;
        data.gestureOwner = null;
        data.touchGestureActive = false;

        this.bind('turning', opts.onTurning).bind('turned', opts.onTurned);

        this.css({ position: 'relative', width: opts.width, height: opts.height });

        for (i = 0; i < ch.length; i++) this.turn('addPage', ch[i], i + 1);

        this.turn('page', 1);

        // Event listeners

        var hideIdleFolds = function () {
          for (var page in data.pages) {
            if (!has(page, data.pages)) continue;
            var allPageData = data.pages[page].data(),
              pageData = allPageData.f;
            if (
              pageData
              && pageData.point
              && !pageData.corner
              && !(allPageData.effect && allPageData.effect.turning)
            ) {
              flipMethods.hideFoldedPage.call(data.pages[page], false);
            }
          }
        };

        var cancelActiveFolds = function () {
          for (var page in data.pages) {
            if (!has(page, data.pages)) continue;
            var allPageData = data.pages[page].data(),
              pageData = allPageData.f;
            if (allPageData.effect && allPageData.effect.turning) continue;
            if (pageData) pageData.corner = null;
          }
          hideIdleFolds();
        };

        data.eventHandlers = {
          start: function (e) {
            if (data.destroyed) return;
            var touchCount = isTouch ? Number(e.originalEvent?.touches?.length) || 0 : 0;
            if (isTouch && data.touchGestureActive && touchCount > 1) {
              return data.gestureOwner === 'page' ? false : undefined;
            }
            if (data.gestureOwner !== null || data.touchGestureActive) cancelActiveFolds();
            if (isTouch) data.touchGestureActive = true;
            data.gestureOwner = isWithinGestureBoundary(e, root) ? 'boundary' : null;
            if (data.gestureOwner === 'boundary') {
              hideIdleFolds();
              return;
            }
            for (var page in data.pages)
              if (has(page, data.pages) && flipMethods._eventStart.call(data.pages[page], e) === false) {
                data.gestureOwner = 'page';
                return false;
              }
          },
          move: function (e) {
            if (data.destroyed) return;
            if (!isTouch && data.gestureOwner !== null && !hasActivePointer(e)) {
              var gestureOwner = data.gestureOwner;
              data.gestureOwner = null;
              if (gestureOwner === 'page') cancelActiveFolds();
              return;
            }
            if (data.gestureOwner === 'boundary') return;
            if (!hasActivePointer(e) && isWithinGestureBoundary(e, root)) {
              hideIdleFolds();
              return;
            }
            for (var page in data.pages) if (has(page, data.pages)) flipMethods._eventMove.call(data.pages[page], e);
          },
          end: function (e) {
            if (data.destroyed) return;
            if (isTouch && (Number(e.originalEvent?.touches?.length) || 0) > 0) return;
            var gestureOwner = data.gestureOwner;
            data.gestureOwner = null;
            data.touchGestureActive = false;
            if (gestureOwner === 'boundary') return;
            for (var page in data.pages) if (has(page, data.pages)) flipMethods._eventEnd.call(data.pages[page], e);
          },
          cancel: function (e) {
            if (data.destroyed) return;
            if ((Number(e.originalEvent?.touches?.length) || 0) > 0) return;
            var gestureOwner = data.gestureOwner;
            data.gestureOwner = null;
            data.touchGestureActive = false;
            if (gestureOwner !== 'boundary') cancelActiveFolds();
          },
        };

        $(this).bind(events.start, data.eventHandlers.start);
        $(document).bind(events.move, data.eventHandlers.move).bind(events.end, data.eventHandlers.end);
        if (events.cancel) $(document).bind(events.cancel, data.eventHandlers.cancel);

        data.done = true;

        return this;
      },

      // Adds a page from external data

      addPage: function (element, page) {
        var data = this.data();

        // Stop animations
        if (data.done) this.turn('stop');

        if (page in data.pageObjs) return this;

        // Add element
        data.pageObjs[page] = $(element).addClass('turn-page p' + page);

        // Add page
        turnMethods._addPage.call(this, page);

        // Update view
        if (data.done) this.turn('update');

        turnMethods._removeFromDOM.call(this);

        return this;
      },

      // Adds a page from internal data

      _addPage: function (page) {
        var data = this.data(),
          element = data.pageObjs[page];

        if (element) {
          if (turnMethods._necessPage.call(this, page)) {
            if (!data.pageWrap[page]) {
              var pageWidth = this.width() / 2,
                pageHeight = this.height();

              element.css({ width: pageWidth, height: pageHeight });

              // Place
              data.pagePlace[page] = page;

              // Wrapper
              data.pageWrap[page] = $('<div/>', {
                class: 'turn-page-wrapper',
                page: page,
                css: { position: 'absolute', overflow: 'hidden', width: pageWidth, height: pageHeight },
              }).css(pagePosition[page % 2]);

              // Append to this
              this.append(data.pageWrap[page]);

              // Move data.pageObjs[page] (element) to wrapper
              data.pageWrap[page].prepend(data.pageObjs[page]);
            }

            // If the page is in the current view, create the flip effect
            if (turnMethods._setPageLoc.call(this, page) == 1) turnMethods._makeFlip.call(this, page);
          } else {
            // Place
            data.pagePlace[page] = 0;

            // Remove element from the DOM
            if (data.pageObjs[page]) data.pageObjs[page].remove();
          }
        }

        // Execute the block in the next event loop (wait for `data.page` to be ready)
        setTimeout(() => {
          if (!data.destroyed && data.shadowElement === null) {
            data.shadowElement = document.createElement('div');
            data.shadowElement.classList.add('shadow');

            if (data.page === 1) {
              data.shadowElement.classList.add('partial-hidden', 'first');
            }

            this.append(data.shadowElement);
          }
        });
      },

      // Checks if a page is in memory

      hasPage: function (page) {
        return page in this.data().pageObjs;
      },

      // Prepares the flip effect for a page

      _makeFlip: function (page) {
        var data = this.data();

        if (!data.pages[page] && data.pagePlace[page] == page) {
          var even = page % 2;

          data.pages[page] = data.pageObjs[page]
            .css({ width: this.width() / 2, height: this.height() })
            .flip({
              page: page,
              next: even ? page + 1 : page - 1,
              turn: this,
              duration: data.opts.duration,
              cornerSize: 100,
              corners: even ? 'forward' : 'backward',
              backGradient: data.opts.gradients,
              frontGradient: data.opts.gradients,
            })
            .flip('disable', false)
            .bind('pressed', turnMethods._pressed)
            .bind('released', turnMethods._released)
            .bind('start', turnMethods._start)
            .bind('end', turnMethods._end);
        }

        if (data.shadowElement !== null) {
          data.shadowElement.classList.remove('partial-hidden', 'left', 'right', 'first');

          if (page === 1) {
            data.shadowElement.classList.add('partial-hidden', 'first');
          } else if (page <= 3) {
            data.shadowElement.classList.add('partial-hidden', 'left');
          } else if (page === data.totalPages) {
            data.shadowElement.classList.add('partial-hidden', 'last');
          } else if (page >= data.totalPages - 2) {
            data.shadowElement.classList.add('partial-hidden', 'right');
          }
        }

        return data.pages[page];
      },

      // Makes pages within a range

      _makeRange: function () {
        var page,
          data = this.data(),
          range = this.turn('range');

        for (page = range[0]; page <= range[1]; page++) turnMethods._addPage.call(this, page);
      },

      // Returns a range of `pagesInDOM` pages that should be in the DOM
      // Example:
      // - page of the current view, return true
      // * page is in the range, return true
      // 0 page is not in the range, return false
      //
      // 1 2-3 4-5 6-7 8-9 10-11 12-13
      //    **  **  --   **  **

      range: function (page) {
        var data = this.data();
        page = page || data.tpage || data.page;
        return pageTurnRange(page, data.totalPages, pagesInDOM);
      },

      // Detects if a page is within the range of `pagesInDOM` from the current view

      _necessPage: function (page) {
        var range = this.turn('range');

        return page >= range[0] && page <= range[1];
      },

      // Releases memory by removing pages from the DOM

      _removeFromDOM: function () {
        var page,
          data = this.data();

        for (page in data.pageWrap)
          if (has(page, data.pageWrap) && !turnMethods._necessPage.call(this, page)) turnMethods._removePageFromDOM.call(this, page);
      },

      // Removes a page from DOM and its internal references

      _removePageFromDOM: function (page) {
        var data = this.data();

        if (data.pages[page]) {
          var dd = data.pages[page].data();
          if (dd.f && dd.f.fwrapper) dd.f.fwrapper.remove();
          data.pages[page].remove();
          delete data.pages[page];
        }

        if (data.pageObjs[page]) data.pageObjs[page].remove();

        if (data.pageWrap[page]) {
          data.pageWrap[page].remove();
          delete data.pageWrap[page];
        }

        delete data.pagePlace[page];
      },

      // Removes an animation from the cache

      _removeMv: function (page) {
        var i,
          data = this.data();

        for (i = 0; i < data.pageMv.length; i++)
          if (data.pageMv[i] == page) {
            data.pageMv.splice(i, 1);
            return;
          }

        return false;
      },

      // Adds an animation to the cache

      _addMv: function (page) {
        var data = this.data();

        turnMethods._removeMv.call(this, page);
        data.pageMv.push(page);
      },

      // Gets a view

      view: function (page) {
        var data = this.data(),
          view = pageTurnView(page || data.page);

        return [view[0] > 0 ? view[0] : 0, view[1] <= data.totalPages ? view[1] : 0];
      },

      // Stops animations

      stop: function () {
        var i,
          opts,
          data = this.data(),
          pages = data.pageMv;

        data.pageMv = [];

        if (data.tpage) {
          data.page = data.tpage;
          delete data['tpage'];
        }

        for (i in pages) {
          if (!has(i, pages)) continue;
          opts = data.pages[pages[i]].data().f.opts;
          flipMethods._moveFoldingPage.call(data.pages[pages[i]], null);
          data.pages[pages[i]].flip('hideFoldedPage');
          data.pagePlace[opts.next] = opts.next;

          if (opts.force) {
            opts.next = opts.page % 2 === 0 ? opts.page - 1 : opts.page + 1;
            delete opts['force'];
          }
        }

        this.turn('update');

        return this;
      },

      // Sets a page without effect

      _fitPage: function (page) {
        var data = this.data(),
          newView = this.turn('view', page);

        if (data.page != page) {
          this.trigger('turning', [page, newView]);
        }

        if (!data.pageObjs[page]) return;

        data.tpage = page;

        this.turn('stop');
        turnMethods._removeFromDOM.call(this);
        turnMethods._makeRange.call(this);
        this.trigger('turned', [page, newView]);
      },

      // Turns to a page

      _turnPage: function (page) {
        var current,
          next,
          data = this.data(),
          view = this.turn('view'),
          newView = this.turn('view', page);

        if (data.page != page) {
          this.trigger('turning', [page, newView]);
        }

        if (!data.pageObjs[page]) return;

        data.tpage = page;

        this.turn('stop');

        turnMethods._makeRange.call(this);

        if (view[1] && page > view[1]) {
          current = view[1];
          next = newView[0];
        } else if (view[0] && page < view[0]) {
          current = view[0];
          next = newView[1];
        }

        if (data.pages[current]) {
          var opts = data.pages[current].data().f.opts;
          data.tpage = next;

          if (opts.next != next) {
            opts.next = next;
            data.pagePlace[next] = opts.page;
            opts.force = true;
          }

          data.pages[current].flip('turnPage');
        }
      },

      // Gets and sets a page

      page: function (page) {
        page = parseInt(page, 10);

        var data = this.data();

        if (page > 0 && page <= data.totalPages) {
          if (!data.done || this.turn('view').indexOf(page) != -1) turnMethods._fitPage.call(this, page);
          else turnMethods._turnPage.call(this, page);
        }
        return this;
      },

      // Adds a motion to the internal list

      _addMotionPage: function () {
        var opts = $(this).data().f.opts,
          turn = opts.turn,
          dd = turn.data();

        opts.pageMv = opts.page;
        turnMethods._addMv.call(turn, opts.pageMv);
        dd.pagePlace[opts.next] = opts.page;
        turn.turn('update');
      },

      // This event is called in context of flip

      _start: function () {
        turnMethods._addMotionPage.call(this);
      },

      // This event is called in context of flip

      _end: function (e, turned) {
        var that = $(this),
          data = that.data().f,
          opts = data.opts,
          turn = opts.turn,
          dd = turn.data();

        if (turned || dd.tpage) {
          if (dd.tpage == opts.next || dd.tpage == opts.page) {
            delete dd['tpage'];
            turnMethods._fitPage.call(turn, dd.tpage || opts.next, true);
          }
        } else {
          turnMethods._removeMv.call(turn, opts.pageMv);
          turn.turn('update');
        }
      },

      // This event is called in context of flip

      _pressed: function () {
        var page,
          that = $(this),
          data = that.data().f,
          turn = data.opts.turn,
          pages = turn.data().pages;

        for (page in pages) if (page != data.opts.page) pages[page].flip('disable', true);

        return (data.time = new Date().getTime());
      },

      // This event is called in context of flip

      _released: function (e, point) {
        var that = $(this),
          data = that.data().f;

        if (new Date().getTime() - data.time < 200 || point.x < 0 || point.x > $(this).width()) {
          e.preventDefault();
          data.opts.turn.data().tpage = data.opts.next;
          data.opts.turn.turn('update');
          $(that).flip('turnPage');
        }
      },

      // Calculate the z-index value for pages during the animation

      calculateZ: function (mv) {
        var data = this.data(),
          currentView = this.turn('view'),
          currentPage = currentView[0] || currentView[1],
          result = { pageZ: {}, partZ: {}, pageV: {}},
          addView = function (page) {
            var view = pageTurnView(page);
            if (view[0] > 0 && view[0] <= data.totalPages) result.pageV[view[0]] = true;
            if (view[1] > 0 && view[1] <= data.totalPages) result.pageV[view[1]] = true;
          };

        for (var i = 0; i < mv.length; i++) {
          var page = mv[i],
            nextPage = data.pages[page].data().f.opts.next,
            placePage = data.pagePlace[page],
            displayPage = data.pagePlace[nextPage] == nextPage ? nextPage : page;
          addView(page);
          addView(nextPage);
          result.pageZ[displayPage] = data.totalPages - Math.abs(currentPage - displayPage);
          result.partZ[placePage] = data.totalPages * 2 + Math.abs(currentPage - displayPage);
        }

        return result;
      },

      // Updates the z-index and display property of every page

      update: function () {
        var page,
          data = this.data();

        if (data.pageMv.length) {
          // Update motion

          var pos = this.turn('calculateZ', data.pageMv);

          for (page in data.pageWrap) {
            if (!has(page, data.pageWrap)) continue;

            data.pageWrap[page].css({ display: pos.pageV[page] ? '' : 'none', 'z-index': pos.pageZ[page] || 0 });

            if (data.pages[page]) {
              data.pages[page].flip('z', pos.partZ[page] || null);

              if (pos.pageV[page]) data.pages[page].flip('resize');

              if (data.tpage) data.pages[page].flip('disable', true); // data.disabled || page!=apage
            }
          }
        } else {
          // Update static pages

          for (page in data.pageWrap) {
            if (!has(page, data.pageWrap)) continue;
            var pageLocation = turnMethods._setPageLoc.call(this, page);
            if (data.pages[page]) data.pages[page].flip('disable', pageLocation != 1).flip('z', null);
          }
        }
      },

      // Removes document listeners, animation timers, generated wrappers, and callbacks.

      destroy: function () {
        var page,
          data = this.data();

        if (!data || data.destroyed) return this;
        data.destroyed = true;

        $(this).unbind(events.start, data.eventHandlers.start);
        $(document).unbind(events.move, data.eventHandlers.move).unbind(events.end, data.eventHandlers.end);
        if (events.cancel) $(document).unbind(events.cancel, data.eventHandlers.cancel);

        for (page in data.pages) {
          if (!has(page, data.pages)) continue;
          data.pages[page].animatef(false);
          unbindAllEvents(data.pages[page][0]);
        }

        if (data.fparent) data.fparent.remove();
        if (this[0]) {
          unbindAllEvents(this[0]);
          this[0].replaceChildren();
          elementData.delete(this[0]);
        }

        return this;
      },

      // Sets the z-index and display property of a page
      // It depends on the current view

      _setPageLoc: function (page) {
        var data = this.data(),
          view = this.turn('view');

        if (page == view[0] || page == view[1]) {
          data.pageWrap[page].css({ 'z-index': data.totalPages, display: '' });
          return 1;
        } else if (
          page == view[0] - 2 ||
          page == view[1] + 2
        ) {
          data.pageWrap[page].css({ 'z-index': data.totalPages - 1, display: '' });
          return 2;
        } else {
          data.pageWrap[page].css({ 'z-index': 0, display: 'none' });
          return 0;
        }
      },
    },
    // Methods and properties for the flip page effect

    flipMethods = {
      // Constructor

      init: function (opts) {
        this.data().f = { opts: opts };

        flipMethods._addPageWrapper.call(this);

        return this;
      },

      setData: function (d) {
        var data = this.data();

        data.f = Object.assign(data.f, d);

        return this;
      },

      z: function (z) {
        var data = this.data().f;
        data.opts['z-index'] = z;
        data.fwrapper.css({ 'z-index': z || parseInt(data.parent.css('z-index'), 10) || 0 });

        return this;
      },

      _cAllowed: function () {
        return corners[this.data().f.opts.corners] || this.data().f.opts.corners;
      },

      _cornerActivated: function (e) {
        if (e.originalEvent === undefined) {
          return false;
        }

        e = isTouch ? e.originalEvent.touches : [e];

        var data = this.data().f,
          pos = data.parent.offset(),
          width = this.width(),
          height = this.height(),
          c = { x: Math.max(0, e[0].pageX - pos.left), y: Math.max(0, e[0].pageY - pos.top) },
          csz = data.opts.cornerSize,
          allowedCorners = flipMethods._cAllowed.call(this);

        if (c.x <= 0 || c.y <= 0 || c.x >= width || c.y >= height) return false;

        if (c.y < csz) c.corner = 't';
        else if (c.y >= height - csz) c.corner = 'b';
        else return false;

        if (c.x <= csz) c.corner += 'l';
        else if (c.x >= width - csz) c.corner += 'r';
        else return false;

        return allowedCorners.indexOf(c.corner) == -1 ? false : c;
      },

      _c: function (corner, opts) {
        opts = opts || 0;
        return {
          tl: point2D(opts, opts),
          tr: point2D(this.width() - opts, opts),
          bl: point2D(opts, this.height() - opts),
          br: point2D(this.width() - opts, this.height() - opts),
        }[corner];
      },

      _c2: function (corner) {
        return {
          tl: point2D(this.width() * 2, 0),
          tr: point2D(-this.width(), 0),
          bl: point2D(this.width() * 2, this.height()),
          br: point2D(-this.width(), this.height()),
        }[corner];
      },

      _foldingPage: function () {
        var opts = this.data().f.opts;
        return opts.turn.data().pageObjs[opts.next];
      },

      _backGradient: function () {
        var data = this.data().f,
          turn = data.opts.turn,
          gradient = data.opts.backGradient && data.opts.page != 2 && data.opts.page != turn.data().totalPages - 1;

        if (gradient && !data.bshadow)
          data.bshadow = $('<div/>', divAtt(0, 0, 1))
            .css({ position: '', width: this.width(), height: this.height() })
            .appendTo(data.parent);

        return gradient;
      },

      resize: function (full) {
        var data = this.data().f,
          width = this.width(),
          height = this.height(),
          size = Math.round(Math.sqrt(Math.pow(width, 2) + Math.pow(height, 2)));

        if (full) {
          data.wrapper.css({ width: size, height: size });
          data.fwrapper.css({ width: size, height: size }).children(':first-child').css({ width: width, height: height });

          data.fpage.css({ width: height, height: width });

          if (data.opts.frontGradient) data.ashadow.css({ width: height, height: width });

          if (flipMethods._backGradient.call(this)) data.bshadow.css({ width: width, height: height });
        }

        if (data.parent.is(':visible')) {
          data.fwrapper.css({ top: data.parent.offset().top, left: data.parent.offset().left });

          data.fparent.css({ top: -data.opts.turn.offset().top, left: -data.opts.turn.offset().left });
        }

        this.flip('z', data.opts['z-index']);
      },

      // Prepares the page by adding a general wrapper and another objects

      _addPageWrapper: function () {
        var data = this.data().f,
          parent = this.parent();

        if (!data.wrapper) {
          data.parent = parent;
          data.fparent = data.opts.turn.data().fparent;

          if (!data.fparent) {
            var fparent = $('<div/>', { css: { 'pointer-events': 'none' } }).hide();
            fparent.data().flips = 0;

            fparent
              .css(divAtt(-data.opts.turn.offset().top, -data.opts.turn.offset().left, 'auto', 'visible').css)
              .appendTo(data.opts.turn);

            data.opts.turn.data().fparent = fparent;

            data.fparent = fparent;
          }

          this.css({ position: 'absolute', top: 0, left: 0, bottom: 'auto', right: 'auto' });

          data.wrapper = $('<div/>', divAtt(0, 0, this.css('z-index')))
            .appendTo(parent)
            .prepend(this);

          data.fwrapper = $('<div/>', divAtt(parent.offset().top, parent.offset().left)).hide().appendTo(data.fparent);

          data.fpage = $('<div/>', { css: { cursor: 'default' } }).appendTo(
            $('<div/>', divAtt(0, 0, 0, 'visible')).appendTo(data.fwrapper)
          );

          if (data.opts.frontGradient) data.ashadow = $('<div/>', divAtt(0, 0, 1)).appendTo(data.fpage);

          // Save data

          flipMethods.setData.call(this, data);

          // Set size
          flipMethods.resize.call(this, true);
        }
      },

      // Takes a 2P point from the screen and applies the transformation

      _fold: function (point) {
        var that = this,
          a = 0,
          alpha = 0,
          beta,
          px,
          gradientEndPointA,
          gradientEndPointB,
          gradientStartV,
          gradientSize,
          gradientOpacity,
          mv = point2D(0, 0),
          df = point2D(0, 0),
          tr = point2D(0, 0),
          width = this.width(),
          height = this.height(),
          folding = flipMethods._foldingPage.call(this),
          tan = Math.tan(alpha),
          data = this.data().f,
          h = data.wrapper.height(),
          o = flipMethods._c.call(this, point.corner),
          top = point.corner.substr(0, 1) == 't',
          left = point.corner.substr(1, 1) == 'l',
          compute = function () {
            var rel = point2D(o.x ? o.x - point.x : point.x, o.y ? o.y - point.y : point.y),
              tan = Math.atan2(rel.y, rel.x),
              middle;

            alpha = A90 - tan;
            a = deg(alpha);
            middle = point2D(left ? width - rel.x / 2 : point.x + rel.x / 2, rel.y / 2);

            var gamma = alpha - Math.atan2(middle.y, middle.x),
              distance = Math.max(0, Math.sin(gamma) * Math.sqrt(Math.pow(middle.x, 2) + Math.pow(middle.y, 2)));

            tr = point2D(distance * Math.sin(alpha), distance * Math.cos(alpha));

            if (alpha > A90) {
              tr.x = tr.x + Math.abs(tr.y * Math.tan(tan));
              tr.y = 0;

              if (Math.round(tr.x * Math.tan(PI - alpha)) < height) {
                point.y = Math.sqrt(Math.pow(height, 2) + 2 * middle.x * rel.x);
                if (top) point.y = height - point.y;
                return compute();
              }
            }

            if (alpha > A90) {
              var beta = PI - alpha,
                dd = h - height / Math.sin(beta);
              mv = point2D(Math.round(dd * Math.cos(beta)), Math.round(dd * Math.sin(beta)));
              if (left) mv.x = -mv.x;
              if (top) mv.y = -mv.y;
            }

            px = Math.round(tr.y / Math.tan(alpha) + tr.x);

            var side = width - px,
              sideX = side * Math.cos(alpha * 2),
              sideY = side * Math.sin(alpha * 2);
            df = point2D(Math.round(left ? side - sideX : px + sideX), Math.round(top ? sideY : height - sideY));

            // GRADIENTS

            gradientSize = side * Math.sin(alpha);
            var endingPoint = flipMethods._c2.call(that, point.corner),
              far = Math.sqrt(Math.pow(endingPoint.x - point.x, 2) + Math.pow(endingPoint.y - point.y, 2));

            gradientOpacity = far < width ? far / width : 1;

            if (data.opts.frontGradient) {
              gradientStartV = gradientSize > 100 ? (gradientSize - 100) / gradientSize : 0;
              gradientEndPointA = point2D(
                ((gradientSize * Math.sin(A90 - alpha)) / height) * 100,
                ((gradientSize * Math.cos(A90 - alpha)) / width) * 100
              );

              if (top) gradientEndPointA.y = 100 - gradientEndPointA.y;
              if (left) gradientEndPointA.x = 100 - gradientEndPointA.x;
            }

            if (flipMethods._backGradient.call(that)) {
              gradientEndPointB = point2D(
                ((gradientSize * Math.sin(alpha)) / width) * 100,
                ((gradientSize * Math.cos(alpha)) / height) * 100
              );
              if (!left) gradientEndPointB.x = 100 - gradientEndPointB.x;
              if (!top) gradientEndPointB.y = 100 - gradientEndPointB.y;
            }
            //

            tr.x = Math.round(tr.x);
            tr.y = Math.round(tr.y);

            return true;
          },
          transform = function (tr, c, x, a) {
            var f = ['0', 'auto'],
              mvW = ((width - h) * x[0]) / 100,
              mvH = ((height - h) * x[1]) / 100,
              v = { left: f[c[0]], top: f[c[1]], right: f[c[2]], bottom: f[c[3]] },
              aliasingFk = a != 90 && a != -90 ? (left ? -1 : 1) : 0;

            x = x[0] + '% ' + x[1] + '%';

            that.css(v).transform(rotate(a) + translate(tr.x + aliasingFk, tr.y), x);

            data.fpage.parent().css(v);
            data.wrapper.transform(translate(-tr.x + mvW - aliasingFk, -tr.y + mvH) + rotate(-a), x);

            data.fwrapper.transform(translate(-tr.x + mv.x + mvW, -tr.y + mv.y + mvH) + rotate(-a), x);
            data.fpage.parent().transform(rotate(a) + translate(tr.x + df.x - mv.x, tr.y + df.y - mv.y), x);

            if (data.opts.frontGradient)
              gradient(
                data.ashadow,
                point2D(left ? 100 : 0, top ? 100 : 0),
                point2D(gradientEndPointA.x, gradientEndPointA.y),
                [
                  [gradientStartV, 'rgba(0,0,0,0)'],
                  [(1 - gradientStartV) * 0.8 + gradientStartV, 'rgba(0,0,0,' + 0.2 * gradientOpacity + ')'],
                  [1, 'rgba(255,255,255,' + 0.2 * gradientOpacity + ')'],
                ]
              );

            if (flipMethods._backGradient.call(that))
              gradient(
                data.bshadow,
                point2D(left ? 0 : 100, top ? 0 : 100),
                point2D(gradientEndPointB.x, gradientEndPointB.y),
                [
                  [0.8, 'rgba(0,0,0,0)'],
                  [1, 'rgba(0,0,0,' + 0.3 * gradientOpacity + ')'],
                  [1, 'rgba(0,0,0,0)'],
                ]
              );
          };

        switch (point.corner) {
          case 'tl':
            point.x = Math.max(point.x, 1);
            compute();
            transform(tr, [1, 0, 0, 1], [100, 0], a);
            data.fpage.transform(translate(-height, -width) + rotate(90 - a * 2), '100% 100%');
            folding.transform(rotate(90) + translate(0, -height), '0% 0%');
            break;
          case 'tr':
            point.x = Math.min(point.x, width - 1);
            compute();
            transform(point2D(-tr.x, tr.y), [0, 0, 0, 1], [0, 0], -a);
            data.fpage.transform(translate(0, -width) + rotate(-90 + a * 2), '0% 100%');
            folding.transform(rotate(270) + translate(-width, 0), '0% 0%');
            break;
          case 'bl':
            point.x = Math.max(point.x, 1);
            compute();
            transform(point2D(tr.x, -tr.y), [1, 1, 0, 0], [100, 100], -a);
            data.fpage.transform(translate(-height, 0) + rotate(-90 + a * 2), '100% 0%');
            folding.transform(rotate(270) + translate(-width, 0), '0% 0%');
            break;
          case 'br':
            point.x = Math.min(point.x, width - 1);
            compute();
            transform(point2D(-tr.x, -tr.y), [0, 1, 1, 0], [0, 100], a);
            data.fpage.transform(rotate(90 - a * 2), '0% 0%');
            folding.transform(rotate(90) + translate(0, -height), '0% 0%');

            break;
        }

        data.point = point;
      },

      _moveFoldingPage: function (bool) {
        var data = this.data().f,
          folding = flipMethods._foldingPage.call(this);

        if (folding) {
          if (bool) {
            if (!data.fpage.children()[data.ashadow ? '1' : '0']) {
              flipMethods.setData.call(this, { backParent: folding.parent() });
              data.fpage.prepend(folding);
            }
          } else {
            if (data.backParent) data.backParent.prepend(folding);
          }
        }
      },

      _showFoldedPage: function (c, animate) {
        var folding = flipMethods._foldingPage.call(this),
          dd = this.data(),
          data = dd.f;

        if (!data.point || data.point.corner != c.corner) {
          this.trigger('start', [data.opts, c.corner]);
        }

        if (folding) {
          if (animate) {
            var that = this,
              point = data.point && data.point.corner == c.corner ? data.point : flipMethods._c.call(this, c.corner, 1);

            this.animatef({
              from: [point.x, point.y],
              to: [c.x, c.y],
              duration: 500,
              frame: function (v) {
                c.x = Math.round(v[0]);
                c.y = Math.round(v[1]);
                flipMethods._fold.call(that, c);
              },
            });
          } else {
            flipMethods._fold.call(this, c);
            if (dd.effect && !dd.effect.turning) this.animatef(false);
          }

          if (!data.fwrapper.is(':visible')) {
            data.fparent.show().data().flips++;
            flipMethods._moveFoldingPage.call(this, true);
            data.fwrapper.show();

            if (data.bshadow) data.bshadow.show();
          }

          return true;
        }

        return false;
      },

      hide: function () {
        var data = this.data().f,
          folding = flipMethods._foldingPage.call(this);

        if (--data.fparent.data().flips === 0) data.fparent.hide();

        this.css({ left: 0, top: 0, right: 'auto', bottom: 'auto' }).transform('', '0% 100%');

        data.wrapper.transform('', '0% 100%');

        data.fwrapper.hide();

        if (data.bshadow) data.bshadow.hide();

        folding.transform('', '0% 0%');

        return this;
      },

      hideFoldedPage: function (animate) {
        var data = this.data().f;

        if (!data.point) return;

        var that = this,
          p1 = data.point,
          hide = function () {
            data.point = null;
            that.flip('hide');
            that.trigger('end', [false]);
          };

        if (animate) {
          var p4 = flipMethods._c.call(this, p1.corner),
            top = p1.corner.substr(0, 1) == 't',
            delta = top ? Math.min(0, p1.y - p4.y) / 2 : Math.max(0, p1.y - p4.y) / 2,
            p2 = point2D(p1.x, p1.y + delta),
            p3 = point2D(p4.x, p4.y - delta);

          this.animatef({
            from: 0,
            to: 1,
            frame: function (v) {
              var np = bezier(p1, p2, p3, p4, v);
              p1.x = np.x;
              p1.y = np.y;
              flipMethods._fold.call(that, p1);
            },
            complete: hide,
            duration: 800,
          });
        } else {
          this.animatef(false);
          hide();
        }
      },

      turnPage: function () {
        var that = this,
          data = this.data().f;

        var corner = { corner: data.corner ? data.corner.corner : flipMethods._cAllowed.call(this)[0] };

        var p1 = data.point || flipMethods._c.call(this, corner.corner, data.opts.turn.data().opts.elevation),
          p4 = flipMethods._c2.call(this, corner.corner);

        this.animatef({
          from: 0,
          to: 1,
          frame: function (v) {
            var np = bezier(p1, p1, p4, p4, v);
            corner.x = np.x;
            corner.y = np.y;
            flipMethods._showFoldedPage.call(that, corner);
          },

          complete: function () {
            that.trigger('end', [true]);
          },
          duration: data.opts.duration,
          turning: true,
        });

        data.corner = null;
      },

      _eventStart: function (e) {
        var allData = this.data(),
          data = allData.f;

        if (!data.disabled && !(allData.effect && allData.effect.turning)) {
          data.corner = flipMethods._cornerActivated.call(this, e);
          if (data.corner && flipMethods._foldingPage.call(this, data.corner)) {
            flipMethods._moveFoldingPage.call(this, true);
            this.trigger('pressed', [data.point]);
            return false;
          } else data.corner = null;
        }
      },

      _eventMove: function (e) {
        var data = this.data().f;

        if (!data) return;

        if (!data.disabled) {
          e = isTouch ? e.originalEvent.touches : [e];

          if (data.corner) {
            var pos = data.parent.offset();

            data.corner.x = e[0].pageX - pos.left;
            data.corner.y = e[0].pageY - pos.top;

            flipMethods._showFoldedPage.call(this, data.corner);
          } else if (!this.data().effect && this.is(':visible')) {
            // roll over

            var corner = flipMethods._cornerActivated.call(this, e[0]);
            if (corner) {
              var origin = flipMethods._c.call(this, corner.corner, data.opts.cornerSize / 2);
              corner.x = origin.x;
              corner.y = origin.y;
              flipMethods._showFoldedPage.call(this, corner, true);
            } else flipMethods.hideFoldedPage.call(this, true);
          }
        }
      },

      _eventEnd: function () {
        var data = this.data().f;

        if (!data) return;

        if (!data.disabled && data.point) {
          var event = new PageTurnEvent('released');
          this.trigger(event, [data.point]);
          if (!event.defaultPrevented) flipMethods.hideFoldedPage.call(this, true);
        }

        data.corner = null;
      },

      disable: function (disable) {
        flipMethods.setData.call(this, { disabled: disable });
        return this;
      },
    },
    cla = function (that, methods, args) {
      return typeof args[0] == 'object'
        ? methods.init.apply(that, args)
        : methods[args[0]].apply(that, Array.prototype.slice.call(args, 1));
    };

  Object.assign($.fn, {
    flip: function (req, opts) {
      return cla(this, flipMethods, arguments);
    },

    turn: function (req) {
      return cla(this, turnMethods, arguments);
    },

    transform: function (transform, origin) {
      var properties = {};

      if (origin) properties['transform-origin'] = origin;

      properties.transform = transform;

      return this.css(properties);
    },

    animatef: function (point) {
      var data = this.data();

      if (data.effect) clearInterval(data.effect.handle);

      if (point) {
        if (!point.to.length) point.to = [point.to];
        if (!point.from.length) point.from = [point.from];
        var j,
          diff = [],
          len = point.to.length,
          that = this,
          time = -30,
          f = function () {
            var j,
              v = [];
            time = Math.min(point.duration, time + 30);

            for (j = 0; j < len; j++) v.push(pageTurnEasing(time, point.from[j], diff[j], point.duration));

            point.frame(len == 1 ? v[0] : v);

            if (time == point.duration) {
              clearInterval(data.effect.handle);
              delete data['effect'];
              if (point.complete) point.complete();
            }
          };

        for (j = 0; j < len; j++) diff.push(point.to[j] - point.from[j]);

        data.effect = point;
        data.effect.handle = setInterval(f, 30);
        f();
      } else {
        delete data['effect'];
      }
    },
  });

})(createDomSet);
/* eslint-enable no-unused-vars, no-plusplus, object-curly-spacing */

export class PageTurn {
  constructor(root, { pageCount, width, height, duration, elevation, onTurning, onTurned }) {
    this.engine = createDomSet(root);
    this.engine.turn({
      pages: pageCount,
      elevation,
      gradients: !isTouch,
      width,
      height,
      duration,
      onTurning: (event, page, view) => {
        onTurning(event, page, view, this);
      },
      onTurned: (event, page, view) => {
        onTurned(event, page, view, this);
      },
    });
  }

  addPage(pageNumber, element) {
    this.engine.turn('addPage', element, pageNumber);
  }

  hasPage(pageNumber) {
    return this.engine.turn('hasPage', pageNumber);
  }

  range(pageNumber) {
    return this.engine.turn('range', pageNumber);
  }

  goToPage(pageNumber) {
    this.engine.turn('page', pageNumber);
  }

  destroy() {
    if (!this.engine) return;
    this.engine.turn('destroy');
    this.engine = null;
  }
}
