#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const enginePath = path.join(repoRoot, 'client/lib/page-turn.mjs');
const engineMathPath = path.join(repoRoot, 'client/lib/page-turn-math.mjs');
const audioViewManagerPath = path.join(repoRoot, 'client/lib/audio-player-view-manager.mjs');
const fixturePath = path.join(repoRoot, 'tests/fixtures/page-turn-browser.html');
const fixtureHTML = readFileSync(fixturePath);
const goldenDirectory = path.join(repoRoot, 'tests/golden/page-turn');
const referenceTracePath = path.join(goldenDirectory, 'reference-trace.json');
const updateGoldens = process.env.UPDATE_PAGE_TURN_GOLDENS === '1';

function decodePNG(png) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.subarray(0, 8).equals(signature), 'golden image must be a PNG');
  let offset = 8;
  let width;
  let height;
  let channels;
  const compressed = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'golden PNG must use 8-bit channels');
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : null;
      assert.ok(channels, `unsupported PNG color type ${data[9]}`);
      assert.equal(data[12], 0, 'interlaced PNGs are not supported');
    } else if (type === 'IDAT') compressed.push(data);
    else if (type === 'IEND') break;
  }

  const packed = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  const paeth = (left, above, upperLeft) => {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
    return aboveDistance <= upperLeftDistance ? above : upperLeft;
  };

  for (let row = 0; row < height; row += 1) {
    const packedOffset = row * (stride + 1);
    const pixelOffset = row * stride;
    const filter = packed[packedOffset];
    for (let column = 0; column < stride; column += 1) {
      const raw = packed[packedOffset + column + 1];
      const left = column >= channels ? pixels[pixelOffset + column - channels] : 0;
      const above = row ? pixels[pixelOffset + column - stride] : 0;
      const upperLeft = row && column >= channels ? pixels[pixelOffset + column - stride - channels] : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? above
            : filter === 3 ? Math.floor((left + above) / 2)
              : filter === 4 ? paeth(left, above, upperLeft)
                : null;
      assert.notEqual(predictor, null, `unsupported PNG filter ${filter}`);
      pixels[pixelOffset + column] = (raw + predictor) % 256;
    }
  }

  return { width, height, channels, pixels };
}

function compareScreenshot(actualPNG, goldenPath) {
  const actual = decodePNG(actualPNG);
  const expected = decodePNG(readFileSync(goldenPath));
  assert.deepEqual(
    [actual.width, actual.height, actual.channels],
    [expected.width, expected.height, expected.channels],
    `${path.basename(goldenPath)} dimensions changed`,
  );

  let changedPixels = 0;
  for (let pixel = 0; pixel < actual.width * actual.height; pixel += 1) {
    let differs = false;
    for (let channel = 0; channel < Math.min(3, actual.channels); channel += 1) {
      const index = pixel * actual.channels + channel;
      if (Math.abs(actual.pixels[index] - expected.pixels[index]) > 8) differs = true;
    }
    if (differs) changedPixels += 1;
  }

  const changedRatio = changedPixels / (actual.width * actual.height);
  assert.ok(
    changedRatio <= 0.005,
    `${path.basename(goldenPath)} changed by ${(changedRatio * 100).toFixed(3)}% of pixels`,
  );
}

function traceState(state) {
  return {
    bufferedPages: state.bufferedPages,
    pageElements: state.pageElements,
    visiblePages: state.visiblePages,
    wrappers: state.wrappers,
    foldDisplay: state.foldDisplay,
    foldChildren: state.foldChildren,
    gradients: state.gradients,
    transformed: state.transformed,
    shadowClass: state.shadowClass,
    events: state.events,
    childCount: state.childCount,
    globals: state.globals,
  };
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const chrome = candidates.find((candidate) => existsSync(candidate));
  if (!chrome) throw new Error('Chrome not found; set CHROME_BIN to its executable path');
  return chrome;
}

function startFixtureServer() {
  const moduleSource = readFileSync(enginePath);
  const mathSource = readFileSync(engineMathPath);
  const audioViewManagerSource = readFileSync(audioViewManagerPath);
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/client/lib/page-turn-math.mjs')) {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(mathSource);
      return;
    }
    if (request.url?.startsWith('/client/lib/page-turn.mjs')) {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(moduleSource);
      return;
    }
    if (request.url?.startsWith('/client/lib/audio-player-view-manager.mjs')) {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(audioViewManagerSource);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(fixtureHTML);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}/fixture` });
    });
  });
}

function launchChrome() {
  const profile = mkdtempSync(path.join(tmpdir(), 'galata-page-turn-chrome-'));
  const devToolsActivePortPath = path.join(profile, 'DevToolsActivePort');
  const chrome = spawn(findChrome(), [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--force-device-scale-factor=1',
    '--font-render-hinting=none',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--window-size=1200,800',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const websocketURL = new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;
    let markerPoll;
    let timeout;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearInterval(markerPoll);
      clearTimeout(timeout);
      callback(value);
    };
    const readDevToolsMarker = () => {
      if (!existsSync(devToolsActivePortPath)) return;
      const [port, endpointPath] = readFileSync(devToolsActivePortPath, 'utf8')
        .trim()
        .split(/\r?\n/);
      if (/^\d+$/.test(port) && endpointPath?.startsWith('/')) {
        settle(resolve, `ws://127.0.0.1:${port}${endpointPath}`);
      }
    };

    chrome.stderr.setEncoding('utf8');
    chrome.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-20_000);
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        settle(resolve, match[1]);
      }
    });
    chrome.once('error', (error) => {
      settle(reject, new Error(`Chrome failed to start: ${error.message}\n${stderr}`));
    });
    chrome.once('exit', (code) => {
      settle(reject, new Error(`Chrome exited before DevTools was ready (${code})\n${stderr}`));
    });
    markerPoll = setInterval(readDevToolsMarker, 25);
    timeout = setTimeout(() => {
      settle(reject, new Error(`Chrome DevTools endpoint timed out\n${stderr}`));
    }, 30_000);
    readDevToolsMarker();
  });

  return {
    chrome,
    profile,
    websocketURL,
    async close() {
      if (chrome.exitCode === null) {
        const exited = new Promise((resolve) => chrome.once('exit', resolve));
        let killTimeout;
        chrome.kill('SIGTERM');
        await Promise.race([
          exited,
          new Promise((resolve) => {
            killTimeout = setTimeout(resolve, 5_000);
          }),
        ]);
        clearTimeout(killTimeout);
        if (chrome.exitCode === null) {
          chrome.kill('SIGKILL');
          await exited;
        }
      }
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

async function launchReadyChrome() {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const browser = launchChrome();
    try {
      const websocketURL = await browser.websocketURL;
      return { ...browser, websocketURL };
    } catch (error) {
      await browser.close();
      if (attempt === 2) throw error;
      process.stderr.write(`Chrome startup attempt ${attempt} failed; retrying.\n${error.message}\n`);
    }
  }
  throw new Error('Chrome failed to start');
}

class DevToolsClient {
  constructor(websocket) {
    this.websocket = websocket;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    websocket.addEventListener('message', (message) => this.onMessage(message.data));
  }

  static async connect(url) {
    const websocket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      websocket.addEventListener('open', resolve, { once: true });
      websocket.addEventListener('error', reject, { once: true });
    });
    return new DevToolsClient(websocket);
  }

  onMessage(rawMessage) {
    const message = JSON.parse(rawMessage);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }

    const index = this.waiters.findIndex((waiter) => (
      waiter.method === message.method
      && (!waiter.sessionId || waiter.sessionId === message.sessionId)
    ));
    if (index !== -1) {
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(message.params || {});
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.websocket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  waitFor(method, sessionId, timeoutMilliseconds = 10_000) {
    return new Promise((resolve, reject) => {
      const waiter = { method, sessionId, resolve, reject };
      waiter.timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMilliseconds);
      this.waiters.push(waiter);
    });
  }

  close() {
    this.websocket.close();
  }
}

async function evaluate(client, sessionId, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result.value;
}

async function waitUntilReady(client, sessionId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const error = await evaluate(client, sessionId, 'window.pageTurnError || null');
    if (error) throw new Error(`Page-turn fixture failed:\n${error}`);
    if (await evaluate(client, sessionId, 'window.pageTurnReady === true')) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const diagnostic = await evaluate(client, sessionId, `({
    error: window.pageTurnError || null,
    ready: window.pageTurnReady || false,
    wrappers: document.querySelectorAll('.turn-page-wrapper').length,
  })`);
  throw new Error(`Page-turn fixture did not initialize: ${JSON.stringify(diagnostic)}`);
}

async function advanceVirtualTime(client, sessionId, budget) {
  const expired = client.waitFor('Emulation.virtualTimeBudgetExpired', sessionId);
  await client.send('Emulation.setVirtualTimePolicy', {
    policy: 'advance',
    budget,
    maxVirtualTimeTaskStarvationCount: 100_000,
  }, sessionId);
  await expired;
  await client.send('Emulation.setVirtualTimePolicy', { policy: 'pause' }, sessionId);
}

async function snapshot(client, sessionId) {
  return evaluate(client, sessionId, 'window.pageTurnFixture.snapshot()');
}

async function captureScreenshot(client, sessionId) {
  const { data } = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: 1000, height: 700, scale: 1 },
  }, sessionId);
  return Buffer.from(data, 'base64');
}

function verifyGoldens(trace, screenshots) {
  if (updateGoldens) {
    mkdirSync(goldenDirectory, { recursive: true });
    writeFileSync(referenceTracePath, `${JSON.stringify(trace, null, 2)}\n`);
    for (const [name, screenshot] of Object.entries(screenshots)) {
      writeFileSync(path.join(goldenDirectory, `${name}.png`), screenshot);
    }
    console.log('Updated PageTurn reference trace and browser images.');
    return;
  }

  assert.ok(existsSync(referenceTracePath), 'PageTurn reference trace is missing');
  assert.deepEqual(trace, JSON.parse(readFileSync(referenceTracePath, 'utf8')));
  for (const [name, screenshot] of Object.entries(screenshots)) {
    const goldenPath = path.join(goldenDirectory, `${name}.png`);
    assert.ok(existsSync(goldenPath), `${name}.png golden image is missing`);
    compareScreenshot(screenshot, goldenPath);
  }
}

async function dispatchMouse(client, sessionId, type, x, y, buttons = 0) {
  await client.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mousePressed' || type === 'mouseReleased' ? 'left' : 'none',
    buttons,
    clickCount: type === 'mousePressed' ? 1 : 0,
  }, sessionId);
}

async function loadFixture(client, sessionId, url, touch = false) {
  await client.send('Emulation.setVirtualTimePolicy', { policy: 'pauseIfNetworkFetchesPending' }, sessionId);
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 2 }, sessionId);
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1200,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  }, sessionId);
  const loaded = client.waitFor('Page.loadEventFired', sessionId);
  await client.send('Page.navigate', { url: `${url}?touch=${touch ? 1 : 0}` }, sessionId);
  await loaded;
  await waitUntilReady(client, sessionId);
  await client.send('Emulation.setVirtualTimePolicy', { policy: 'pause' }, sessionId);
  await advanceVirtualTime(client, sessionId, 1);
}

async function runMouseParity(client, sessionId, url) {
  const trace = {};
  const screenshots = {};
  await loadFixture(client, sessionId, url);

  let state = await snapshot(client, sessionId);
  assert.deepEqual(state.globals, { dollar: 'undefined', jquery: 'undefined' });
  assert.deepEqual(state.bufferedPages, [1, 2, 3, 4, 5, 6]);
  assert.equal(state.pageElements, 6);
  assert.match(state.shadowClass, /shadow/);
  trace.initial = traceState(state);
  screenshots.initial = await captureScreenshot(client, sessionId);

  await evaluate(client, sessionId, 'window.pageTurnFixture.go(5)');
  await advanceVirtualTime(client, sessionId, 630);
  state = await snapshot(client, sessionId);
  assert.deepEqual(state.bufferedPages, [2, 3, 4, 5, 6, 7]);
  assert.deepEqual(state.events.slice(-3), [
    ['turning', 5, [4, 5]],
    ['turning', 4, [4, 5]],
    ['turned', 4, [4, 5]],
  ]);
  assert.equal(state.pageElements, 6);
  trace.middle = traceState(state);
  screenshots.middle = await captureScreenshot(client, sessionId);

  await evaluate(client, sessionId, 'window.pageTurnFixture.go(1)');
  await advanceVirtualTime(client, sessionId, 630);
  state = await snapshot(client, sessionId);
  assert.deepEqual(state.bufferedPages, [1, 2, 3, 4, 5, 6]);
  assert.match(state.shadowClass, /first/);
  trace.first = traceState(state);

  await dispatchMouse(client, sessionId, 'mouseMoved', 995, 695);
  await advanceVirtualTime(client, sessionId, 510);
  state = await snapshot(client, sessionId);
  assert.notEqual(state.foldDisplay, 'none', 'hovering a corner must show a folded page');
  assert.ok(state.gradients.length > 0, 'folding must create gradients');
  assert.ok(state.transformed.length > 0, 'folding must apply transforms');
  trace.forwardHover = traceState(state);
  screenshots.forwardHover = await captureScreenshot(client, sessionId);

  await dispatchMouse(client, sessionId, 'mouseMoved', 750, 350);
  await advanceVirtualTime(client, sessionId, 810);
  state = await snapshot(client, sessionId);
  assert.equal(state.foldDisplay, 'none', 'leaving a corner must hide the hover fold');

  const eventsBeforeQuickRelease = state.events.length;
  const playerMovesBeforeCrossing = state.playerControlMoveEvents;
  const crossingX = state.playerControlRect.left + state.playerControlRect.width * 0.8;
  const crossingY = state.playerControlRect.top + state.playerControlRect.height / 2;
  await dispatchMouse(client, sessionId, 'mouseMoved', 995, 695);
  await dispatchMouse(client, sessionId, 'mousePressed', 995, 695, 1);
  await dispatchMouse(client, sessionId, 'mouseMoved', crossingX, crossingY, 1);
  state = await snapshot(client, sessionId);
  assert.ok(
    state.playerControlMoveEvents > playerMovesBeforeCrossing,
    'the page-owned gesture must cross the player boundary',
  );
  assert.notEqual(
    state.foldDisplay,
    'none',
    'a page-owned gesture must keep folding when it crosses the player',
  );
  await dispatchMouse(client, sessionId, 'mouseMoved', 700, 620, 1);
  await dispatchMouse(client, sessionId, 'mouseReleased', 700, 620);
  await advanceVirtualTime(client, sessionId, 630);
  state = await snapshot(client, sessionId);
  assert.deepEqual(state.events.slice(eventsBeforeQuickRelease, eventsBeforeQuickRelease + 2), [
    ['turning', 2, [2, 3]],
    ['turned', 2, [2, 3]],
  ]);
  trace.forwardQuickRelease = traceState(state);

  await evaluate(client, sessionId, 'window.pageTurnFixture.createEngine(1)');
  await advanceVirtualTime(client, sessionId, 1);
  const eventsBeforeSlowRelease = (await snapshot(client, sessionId)).events.length;
  await dispatchMouse(client, sessionId, 'mouseMoved', 995, 5);
  await dispatchMouse(client, sessionId, 'mousePressed', 995, 5, 1);
  await dispatchMouse(client, sessionId, 'mouseMoved', 800, 120, 1);
  await advanceVirtualTime(client, sessionId, 220);
  await dispatchMouse(client, sessionId, 'mouseReleased', 800, 120);
  await advanceVirtualTime(client, sessionId, 810);
  state = await snapshot(client, sessionId);
  assert.equal(state.events.length, eventsBeforeSlowRelease, 'slow release must cancel the turn');
  trace.forwardSlowRelease = traceState(state);

  await evaluate(client, sessionId, 'window.pageTurnFixture.go(5); window.pageTurnFixture.go(2)');
  await advanceVirtualTime(client, sessionId, 630);
  state = await snapshot(client, sessionId);
  assert.deepEqual(state.events.slice(-2), [
    ['turning', 3, [2, 3]],
    ['turned', 3, [2, 3]],
  ]);
  trace.rapidInterruption = traceState(state);

  await evaluate(client, sessionId, 'window.pageTurnFixture.go(10)');
  await advanceVirtualTime(client, sessionId, 630);
  state = await snapshot(client, sessionId);
  assert.deepEqual(state.bufferedPages, [5, 6, 7, 8, 9, 10]);
  assert.match(state.shadowClass, /last/);
  trace.last = traceState(state);
  screenshots.last = await captureScreenshot(client, sessionId);

  await evaluate(client, sessionId, 'window.pageTurnFixture.go(5)');
  await advanceVirtualTime(client, sessionId, 630);
  const eventsBeforeBackwardRelease = (await snapshot(client, sessionId)).events.length;
  await dispatchMouse(client, sessionId, 'mouseMoved', 5, 695);
  await dispatchMouse(client, sessionId, 'mousePressed', 5, 695, 1);
  await dispatchMouse(client, sessionId, 'mouseMoved', 300, 620, 1);
  await dispatchMouse(client, sessionId, 'mouseReleased', 300, 620);
  await advanceVirtualTime(client, sessionId, 630);
  state = await snapshot(client, sessionId);
  assert.deepEqual(state.events.slice(eventsBeforeBackwardRelease, eventsBeforeBackwardRelease + 2), [
    ['turning', 3, [2, 3]],
    ['turned', 3, [2, 3]],
  ]);
  trace.backwardQuickRelease = traceState(state);

  await evaluate(client, sessionId, 'window.pageTurnFixture.createEngine(1)');
  await advanceVirtualTime(client, sessionId, 1);
  await evaluate(client, sessionId, 'window.pageTurnFixture.destroy()');
  await advanceVirtualTime(client, sessionId, 900);
  state = await snapshot(client, sessionId);
  assert.equal(state.childCount, 0, 'idle destroy must discard every generated node');

  await evaluate(client, sessionId, 'window.pageTurnFixture.createEngine(1)');
  await advanceVirtualTime(client, sessionId, 1);
  await dispatchMouse(client, sessionId, 'mouseMoved', 995, 695);
  await dispatchMouse(client, sessionId, 'mousePressed', 995, 695, 1);
  await dispatchMouse(client, sessionId, 'mouseMoved', 700, 620, 1);
  const eventCountDuringDrag = (await snapshot(client, sessionId)).events.length;
  await evaluate(client, sessionId, 'window.pageTurnFixture.destroy()');
  await advanceVirtualTime(client, sessionId, 900);
  state = await snapshot(client, sessionId);
  assert.equal(state.childCount, 0, 'drag destroy must discard every generated node');
  assert.equal(state.events.length, eventCountDuringDrag, 'drag destroy must suppress callbacks');

  await evaluate(client, sessionId, 'window.pageTurnFixture.createEngine(1)');
  await advanceVirtualTime(client, sessionId, 1);
  await evaluate(client, sessionId, 'window.pageTurnFixture.go(8)');
  await advanceVirtualTime(client, sessionId, 90);
  const eventCountAtDestroy = (await snapshot(client, sessionId)).events.length;
  await evaluate(client, sessionId, 'window.pageTurnFixture.destroy()');
  await advanceVirtualTime(client, sessionId, 900);
  state = await snapshot(client, sessionId);
  assert.equal(state.childCount, 0);
  assert.equal(state.events.length, eventCountAtDestroy, 'destroy must suppress animation callbacks');
  trace.destroyed = traceState(state);

  return { trace, screenshots };
}

async function runTouchParity(client, sessionId, url) {
  await loadFixture(client, sessionId, url, true);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 995, y: 695, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
  }, sessionId);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: 700, y: 620, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
  }, sessionId);
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
  await advanceVirtualTime(client, sessionId, 630);
  const state = await snapshot(client, sessionId);
  assert.deepEqual(state.events.slice(-2), [
    ['turning', 2, [2, 3]],
    ['turned', 2, [2, 3]],
  ]);
  assert.equal(state.gradients.length, 0, 'touch mode must preserve the legacy gradient setting');
  return traceState(state);
}

async function runPlayerControlIsolation(client, sessionId, url, interaction = 'mouse-drag') {
  const touch = interaction === 'touch';
  await loadFixture(client, sessionId, url, touch);
  const before = await snapshot(client, sessionId);
  assert.ok(before.playerControlRect, 'player control fixture must be mounted');
  const { left, top, width, height } = before.playerControlRect;
  const startX = left + width * 0.25;
  const endX = left + width * 0.8;
  const y = top + height / 2;
  const outsideY = top + height + 25;

  const assertPageIsStable = (state, message) => {
    assert.equal(state.events.length, before.events.length, `${message} must not turn the page`);
    assert.deepEqual(state.visiblePages, before.visiblePages, `${message} must preserve the page`);
    assert.equal(state.foldDisplay, 'none', `${message} must not display a folded page`);
  };

  if (!touch) {
    await dispatchMouse(client, sessionId, 'mouseMoved', 995, 695);
    await advanceVirtualTime(client, sessionId, 510);
    assert.notEqual(
      (await snapshot(client, sessionId)).foldDisplay,
      'none',
      'hovering outside the player must show a folded page',
    );
    await dispatchMouse(client, sessionId, 'mouseMoved', endX, y);
    await advanceVirtualTime(client, sessionId, 1);
    assertPageIsStable(
      await snapshot(client, sessionId),
      'entering a player control from an idle fold',
    );
  }

  if (touch) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: startX, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
    }, sessionId);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: endX, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
    }, sessionId);
    assertPageIsStable(await snapshot(client, sessionId), 'touch movement inside the player');
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: endX, y: outsideY, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
    }, sessionId);
    assertPageIsStable(await snapshot(client, sessionId), 'touch movement outside the player');
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
  } else if (interaction === 'mouse-click') {
    await dispatchMouse(client, sessionId, 'mousePressed', endX, y, 1);
    await dispatchMouse(client, sessionId, 'mouseReleased', endX, y);
  } else {
    await dispatchMouse(client, sessionId, 'mousePressed', startX, y, 1);
    await dispatchMouse(client, sessionId, 'mouseMoved', endX, y, 1);
    assertPageIsStable(await snapshot(client, sessionId), 'mouse movement inside the player');
    await dispatchMouse(client, sessionId, 'mouseMoved', endX, outsideY, 1);
    assertPageIsStable(await snapshot(client, sessionId), 'mouse movement outside the player');
    await dispatchMouse(client, sessionId, 'mouseReleased', endX, outsideY);
  }

  await advanceVirtualTime(client, sessionId, 810);
  const after = await snapshot(client, sessionId);
  assert.equal(after.playerControlGestureStarts, 1, 'player must receive the gesture start');
  assert.ok(after.playerControlInputEvents > 0, 'native range interaction must emit input');
  assert.ok(after.playerControlValue > before.playerControlValue, 'native range value must change');
  assertPageIsStable(after, 'the completed player interaction');
}

async function runPlayerMultiTouchIsolation(client, sessionId, url) {
  await loadFixture(client, sessionId, url, true);
  const before = await snapshot(client, sessionId);
  assert.ok(before.playerControlRect, 'multi-touch player control must be mounted');
  const { left, top, width, height } = before.playerControlRect;
  const startX = left + width * 0.72;
  const endX = left + width * 0.92;
  const y = top + height / 2;
  const secondTouch = { x: 700, y: 350, id: 2, radiusX: 1, radiusY: 1, force: 1 };
  const firstTouch = (x) => ({ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 });

  const assertBoundaryOwnsGesture = (state, message) => {
    assert.equal(state.events.length, before.events.length, `${message} must not turn the page`);
    assert.deepEqual(state.visiblePages, before.visiblePages, `${message} must preserve the page`);
    assert.equal(state.foldDisplay, 'none', `${message} must not display a folded page`);
  };

  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [firstTouch(startX)],
  }, sessionId);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [firstTouch(startX), secondTouch],
  }, sessionId);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [firstTouch(endX), secondTouch],
  }, sessionId);
  assertBoundaryOwnsGesture(await snapshot(client, sessionId), 'adding and moving a second touch');

  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [firstTouch(endX)],
  }, sessionId);
  assertBoundaryOwnsGesture(await snapshot(client, sessionId), 'releasing the second touch');

  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [firstTouch(endX)],
  }, sessionId);
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
  await advanceVirtualTime(client, sessionId, 810);

  const after = await snapshot(client, sessionId);
  assert.equal(
    after.playerControlGestureStarts,
    2,
    'both touchstart events must remain targeted at the original player boundary',
  );
  assert.ok(after.playerControlInputEvents > 0, 'the multi-touch range must emit native input');
  assert.ok(after.playerControlValue > before.playerControlValue, 'the multi-touch range value must change');
  assertBoundaryOwnsGesture(after, 'the completed multi-touch interaction');
}

async function runTouchCancelRecovery(client, sessionId, url) {
  await loadFixture(client, sessionId, url, true);
  const before = await snapshot(client, sessionId);
  const point = (x, y) => ({ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 });

  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [point(995, 695)],
  }, sessionId);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [point(700, 620)],
  }, sessionId);
  assert.notEqual(
    (await snapshot(client, sessionId)).foldDisplay,
    'none',
    'a page-owned touch must create a fold before cancellation',
  );
  await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }, sessionId);
  await advanceVirtualTime(client, sessionId, 1);

  let state = await snapshot(client, sessionId);
  assert.equal(state.foldDisplay, 'none', 'touch cancellation must remove the active fold');
  assert.equal(state.events.length, before.events.length, 'touch cancellation must not turn the page');
  assert.deepEqual(state.visiblePages, before.visiblePages, 'touch cancellation must preserve the page');

  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [point(995, 695)],
  }, sessionId);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [point(700, 620)],
  }, sessionId);
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
  await advanceVirtualTime(client, sessionId, 630);

  state = await snapshot(client, sessionId);
  assert.deepEqual(state.events.slice(before.events.length), [
    ['turning', 2, [2, 3]],
    ['turned', 2, [2, 3]],
  ]);
}

async function runPlayerControlAfterLostPageRelease(client, sessionId, url) {
  await loadFixture(client, sessionId, url);
  const before = await snapshot(client, sessionId);
  assert.ok(before.playerControlRect, 'the lost-release player control must be mounted');
  const controlX = before.playerControlRect.left + before.playerControlRect.width * 0.8;
  const controlY = before.playerControlRect.top + before.playerControlRect.height / 2;

  await dispatchMouse(client, sessionId, 'mouseMoved', 995, 695);
  await dispatchMouse(client, sessionId, 'mousePressed', 995, 695, 1);
  await dispatchMouse(client, sessionId, 'mouseMoved', 700, 620, 1);
  assert.notEqual(
    (await snapshot(client, sessionId)).foldDisplay,
    'none',
    'a page drag must create a fold before its release is lost',
  );

  // Re-entering with no pressed button models a release that happened outside
  // the document and therefore never reached PageTurn's mouseup listener.
  await dispatchMouse(client, sessionId, 'mouseMoved', controlX, controlY);
  let state = await snapshot(client, sessionId);
  assert.equal(state.foldDisplay, 'none', 'a buttonless move must remove the abandoned fold');
  assert.equal(state.events.length, before.events.length, 'lost-release recovery must not turn the page');
  assert.deepEqual(state.visiblePages, before.visiblePages, 'lost-release recovery must preserve the page');

  await dispatchMouse(client, sessionId, 'mousePressed', controlX, controlY, 1);
  await dispatchMouse(client, sessionId, 'mouseReleased', controlX, controlY);
  await advanceVirtualTime(client, sessionId, 1);

  state = await snapshot(client, sessionId);
  assert.equal(state.foldDisplay, 'none', 'the recovered player gesture must not create a fold');
  assert.equal(state.events.length, before.events.length, 'the recovered player gesture must not turn the page');
  assert.deepEqual(state.visiblePages, before.visiblePages, 'the recovered player gesture must preserve the page');
  assert.equal(state.playerControlGestureStarts, 1, 'the player must receive the recovery gesture');
  assert.ok(state.playerControlInputEvents > 0, 'the recovery range must emit native input');
  assert.ok(state.playerControlValue > before.playerControlValue, 'the recovery range value must change');

  await dispatchMouse(client, sessionId, 'mouseMoved', 995, 695);
  await dispatchMouse(client, sessionId, 'mousePressed', 995, 695, 1);
  await dispatchMouse(client, sessionId, 'mouseMoved', 700, 620, 1);
  await dispatchMouse(client, sessionId, 'mouseReleased', 700, 620);
  await advanceVirtualTime(client, sessionId, 630);

  state = await snapshot(client, sessionId);
  assert.deepEqual(state.events.slice(before.events.length), [
    ['turning', 2, [2, 3]],
    ['turned', 2, [2, 3]],
  ]);
}

async function runPlayerControlDuringTurnAnimation(client, sessionId, url) {
  await loadFixture(client, sessionId, url);
  await evaluate(client, sessionId, 'window.pageTurnFixture.addOverlayPlayerControl()');
  const before = await snapshot(client, sessionId);
  const eventsBeforeTurn = before.events.length;
  const controlBefore = await evaluate(client, sessionId, `(() => {
    const control = document.querySelector('[data-fixture-player-page="overlay"]');
    const rect = control?.getBoundingClientRect();
    return rect ? {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      value: Number(control.value),
    } : null;
  })()`);
  assert.ok(controlBefore, 'the overlay player control must be mounted');
  const controlX = controlBefore.left + controlBefore.width * 0.8;
  const controlY = controlBefore.top + controlBefore.height / 2;
  const controlHitTarget = await evaluate(client, sessionId, `(() => {
    const target = document.elementFromPoint(${controlX}, ${controlY});
    return target ? { className: target.className, page: target.dataset.fixturePlayerPage } : null;
  })()`);
  assert.deepEqual(
    controlHitTarget,
    { className: 'fixture-player-range', page: 'overlay' },
    'the overlay player control must be the pointer target',
  );

  await dispatchMouse(client, sessionId, 'mouseMoved', 995, 695);
  await dispatchMouse(client, sessionId, 'mousePressed', 995, 695, 1);
  await dispatchMouse(client, sessionId, 'mouseMoved', 700, 620, 1);
  await dispatchMouse(client, sessionId, 'mouseReleased', 700, 620);

  let state = await snapshot(client, sessionId);
  assert.notEqual(state.foldDisplay, 'none', 'the committed turn must begin its animation');
  assert.equal(state.events.length, eventsBeforeTurn, 'the committed turn must still be in flight');
  const inFlightHitTarget = await evaluate(client, sessionId, `(() => {
    const target = document.elementFromPoint(${controlX}, ${controlY});
    return target ? { className: target.className, page: target.dataset.fixturePlayerPage } : null;
  })()`);
  assert.deepEqual(
    inFlightHitTarget,
    { className: 'fixture-player-range', page: 'overlay' },
    'the overlay player control must remain the pointer target during the turn',
  );

  await dispatchMouse(client, sessionId, 'mouseMoved', controlX, controlY);
  state = await snapshot(client, sessionId);
  assert.notEqual(
    state.foldDisplay,
    'none',
    'hovering the player must not dismiss a committed turn animation',
  );
  await dispatchMouse(client, sessionId, 'mousePressed', controlX, controlY, 1);
  await dispatchMouse(client, sessionId, 'mouseReleased', controlX, controlY);

  state = await snapshot(client, sessionId);
  assert.equal(state.playerControlGestureStarts, 1, 'player must receive the in-flight gesture');
  assert.ok(state.playerControlInputEvents > 0, 'the in-flight native range must emit input');
  const controlValue = await evaluate(
    client,
    sessionId,
    'Number(document.querySelector(\'[data-fixture-player-page="overlay"]\').value)',
  );
  assert.ok(controlValue > controlBefore.value, 'the in-flight range value must change');
  assert.notEqual(
    state.foldDisplay,
    'none',
    'the player gesture must not complete the committed turn early',
  );
  assert.equal(state.events.length, eventsBeforeTurn, 'the turn must remain in flight after player input');

  await advanceVirtualTime(client, sessionId, 630);
  state = await snapshot(client, sessionId);
  assert.deepEqual(state.events.slice(eventsBeforeTurn), [
    ['turning', 2, [2, 3]],
    ['turned', 2, [2, 3]],
  ]);
}

async function runAudioViewLifecycle(client, sessionId, url) {
  await loadFixture(client, sessionId, url);
  let state = await snapshot(client, sessionId);
  assert.equal(state.audioViews, 1);
  assert.equal(state.audioMountedViews, 1);
  assert.equal(state.audioMountCalls, 1);

  await evaluate(client, sessionId, 'window.pageTurnFixture.setAudioTime(37)');
  await evaluate(client, sessionId, 'window.pageTurnFixture.go(10)');
  await advanceVirtualTime(client, sessionId, 630);
  state = await snapshot(client, sessionId);
  assert.equal(state.audioViews, 0, 'detached cached pages must unmount their player view');
  assert.equal(state.audioMountedViews, 0);
  assert.equal(state.audioUnmountCalls, 1);

  await evaluate(client, sessionId, 'window.pageTurnFixture.go(1)');
  await advanceVirtualTime(client, sessionId, 630);
  state = await snapshot(client, sessionId);
  assert.equal(state.audioViews, 1, 'reattached cached pages must remount their player view');
  assert.equal(state.audioMountedViews, 1);
  assert.equal(state.audioMountCalls, 2);
  assert.equal(state.audioViewText, '37', 'remounted views must reuse shared player state');

  await evaluate(client, sessionId, 'window.pageTurnFixture.destroy()');
  await advanceVirtualTime(client, sessionId, 1);
  state = await snapshot(client, sessionId);
  assert.equal(state.audioViews, 0);
  assert.equal(state.audioMountedViews, 0);
  assert.equal(state.audioUnmountCalls, 2, 'final disposal must unmount the remounted view');
}

const fixture = await startFixtureServer();
let browser;
let client;

try {
  browser = await launchReadyChrome();
  client = await DevToolsClient.connect(browser.websocketURL);
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, sessionId);
  await client.send('Runtime.enable', {}, sessionId);
  const parity = await runMouseParity(client, sessionId, fixture.url);
  parity.trace.touch = await runTouchParity(client, sessionId, fixture.url);
  await runPlayerControlIsolation(client, sessionId, fixture.url, 'mouse-click');
  await runPlayerControlIsolation(client, sessionId, fixture.url, 'mouse-drag');
  await runPlayerControlIsolation(client, sessionId, fixture.url, 'touch');
  await runPlayerMultiTouchIsolation(client, sessionId, fixture.url);
  await runTouchCancelRecovery(client, sessionId, fixture.url);
  await runPlayerControlAfterLostPageRelease(client, sessionId, fixture.url);
  await runPlayerControlDuringTurnAnimation(client, sessionId, fixture.url);
  await runAudioViewLifecycle(client, sessionId, fixture.url);
  verifyGoldens(parity.trace, parity.screenshots);
  console.log('PageTurn browser parity checks passed.');
} finally {
  client?.close();
  await browser?.close();
  await new Promise((resolve) => fixture.server.close(resolve));
}
