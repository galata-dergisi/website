#!/usr/bin/env node

// Guard against the Chrome-only carousel lag with the real generated homepage.
// The local server adds latency only to optimized carousel-cover responses,
// while DevTools sends right-arrow mouse clicks at a fixed sub-50ms cadence.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedSiteScript = path.join(repoRoot, 'scripts', 'generate-site.js');
const generatedClient = path.join(repoRoot, 'public', 'bundle.js');
const generatedSSR = path.join(repoRoot, 'build', 'ssr', 'HomePage.cjs');
const reportDirectory = path.join(repoRoot, 'build', 'carousel-lag');
const lagClickCount = 30;
const lagClickIntervalMilliseconds = 25;
const edgeClickCount = 60;
const edgeClickIntervalsMilliseconds = [25, 5];
const edgeAttemptsPerInterval = 4;
const coverDelayMilliseconds = 180;
const maximumRenderedItems = 8;
const maximumCoverRequests = 12;
const midBurstCaptureMilliseconds = 500;
const settleMilliseconds = 1_300;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function generateDevelopmentSite(siteRoot, baseUrl) {
  if (!existsSync(generatedClient) || !existsSync(generatedSSR)) {
    throw new Error('Browser and SSR bundles are missing; run `npm run build:client` first');
  }
  const result = spawnSync(process.execPath, [
    generatedSiteScript,
    '--mode', 'development',
    '--database', path.join(repoRoot, 'content', 'public.sqlite'),
    '--output', siteRoot,
    '--base-url', baseUrl,
    '--generation-token', 'carousel-lag-test',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error([
      'Could not generate the carousel test site.',
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
}

function startSiteServer() {
  let siteRoot = null;
  let manifest = null;
  let coverRequests = 0;
  const server = createServer(async (request, response) => {
    if (!siteRoot || !manifest) {
      response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Test site is still being generated.');
      return;
    }

    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (requestUrl.pathname === '/__dev/status') {
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify({ generation: 'carousel-lag-test', server: 'test' }));
      return;
    }

    const redirect = manifest.redirects[requestUrl.pathname];
    if (redirect) {
      response.writeHead(redirect.status || 308, { Location: redirect.location || redirect });
      response.end();
      return;
    }

    const route = manifest.routes[requestUrl.pathname] || manifest.notFound;
    const isCover = /^\/images\/homepage-covers\/sayi[1-9][0-9]*-(100|180)\.[^/]+\.avif$/
      .test(requestUrl.pathname);
    const body = readFileSync(path.join(siteRoot, route.file));
    if (isCover) {
      coverRequests += 1;
      await wait(coverDelayMilliseconds);
    }

    response.writeHead(manifest.routes[requestUrl.pathname] ? 200 : 404, {
      'Cache-Control': 'no-store',
      'Content-Length': body.length,
      'Content-Type': route.contentType,
      ETag: route.etag,
      ...(isCover ? { 'X-Carousel-Test-Delay': String(coverDelayMilliseconds) } : {}),
    });
    response.end(body);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
        load(nextSiteRoot) {
          siteRoot = nextSiteRoot;
          manifest = JSON.parse(readFileSync(path.join(siteRoot, 'manifest.json'), 'utf8'));
        },
        getCoverRequests() {
          return coverRequests;
        },
        resetCoverRequests() {
          coverRequests = 0;
        },
      });
    });
  });
}

function launchChrome() {
  const profile = mkdtempSync(path.join(tmpdir(), 'galata-carousel-lag-chrome-'));
  const chrome = spawn(findChrome(), [
    '--headless=new',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--force-device-scale-factor=1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--window-size=1200,900',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const websocketURL = new Promise((resolve, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Chrome DevTools endpoint timed out\n${stderr}`));
    }, 15_000);
    chrome.stderr.setEncoding('utf8');
    chrome.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    chrome.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before DevTools was ready (${code})\n${stderr}`));
    });
  });

  return {
    chrome,
    profile,
    websocketURL,
    async close() {
      if (chrome.exitCode === null) {
        const exited = new Promise((resolve) => chrome.once('exit', resolve));
        chrome.kill('SIGTERM');
        await exited;
      }
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
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
    if (index === -1) return;
    const [waiter] = this.waiters.splice(index, 1);
    clearTimeout(waiter.timeout);
    waiter.resolve(message.params || {});
  }

  send(method, parameters = {}, sessionId) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.websocket.send(JSON.stringify({
        id,
        method,
        params: parameters,
        ...(sessionId ? { sessionId } : {}),
      }));
    });
  }

  waitFor(method, sessionId, timeoutMilliseconds = 15_000) {
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

async function waitForCarousel(client, sessionId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const ready = await evaluate(client, sessionId, `(() => {
      const button = document.querySelector('.right-arrow button');
      const items = document.querySelector('.row-2 .items');
      return Boolean(button && items);
    })()`);
    if (ready) return;
    await wait(25);
  }
  throw new Error('The generated homepage did not mount its carousel');
}

async function captureScreenshot(client, sessionId) {
  const { data } = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  }, sessionId);
  return Buffer.from(data, 'base64');
}

async function dispatchClickBurst(client, sessionId, point, options = {}) {
  const count = options.count ?? lagClickCount;
  const intervalMilliseconds = options.intervalMilliseconds
    ?? lagClickIntervalMilliseconds;
  const dispatchTimes = [];
  const pendingCommands = [];
  const startedAt = performance.now();
  pendingCommands.push(client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
  }, sessionId));

  for (let index = 0; index < count; index += 1) {
    const targetTime = startedAt + index * intervalMilliseconds;
    await wait(Math.max(0, targetTime - performance.now()));
    dispatchTimes.push(performance.now());
    pendingCommands.push(client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    }, sessionId));
    pendingCommands.push(client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    }, sessionId));
  }

  await Promise.all(pendingCommands);
  const intervals = dispatchTimes.slice(1).map((time, index) => time - dispatchTimes[index]);
  return {
    count: dispatchTimes.length,
    intervalMilliseconds,
    minimumIntervalMilliseconds: Math.min(...intervals),
    maximumIntervalMilliseconds: Math.max(...intervals),
  };
}

const installProbeExpression = `(() => {
  const button = document.querySelector('.right-arrow button');
  const startedAt = performance.now();
  const clickTimes = [];
  const samples = [];
  const snapshot = () => {
    const track = document.querySelector('.row-2 .items');
    const shelf = document.querySelector('.row-2');
    const anchors = Array.from(track?.querySelectorAll(':scope > a') || []);
    const visibleAnchors = anchors.filter((anchor) => !anchor.classList.contains('hidden'));
    const shelfRect = shelf?.getBoundingClientRect();
    const onShelfAnchors = shelfRect ? visibleAnchors.filter((anchor) => {
      const rect = anchor.getBoundingClientRect();
      return rect.right > shelfRect.left
        && rect.left < shelfRect.right
        && rect.bottom > shelfRect.top
        && rect.top < shelfRect.bottom;
    }) : [];
    const paintedOnShelfItems = onShelfAnchors.filter((anchor) => {
      const style = getComputedStyle(anchor);
      return style.visibility !== 'hidden' && Number(style.opacity) > 0.05;
    }).length;
    return {
      atMilliseconds: Math.round((performance.now() - startedAt) * 1000) / 1000,
      renderedItems: anchors.length,
      visibleItems: visibleAnchors.length,
      onShelfItems: onShelfAnchors.length,
      paintedOnShelfItems,
      pendingImages: anchors.filter((anchor) => {
        const image = anchor.querySelector('img');
        return image && (!image.complete || image.naturalWidth === 0);
      }).length,
      rightArrowDisabled: button.disabled,
      runningAnimations: shelf
        ? shelf.getAnimations({ subtree: true })
          .filter((animation) => animation.playState === 'running').length
        : 0,
      transform: track ? getComputedStyle(track).transform : null,
    };
  };
  button.addEventListener('click', () => clickTimes.push(performance.now() - startedAt));
  samples.push(snapshot());
  const timer = setInterval(() => samples.push(snapshot()), 16);
  window.__carouselLagProbe = {
    finish() {
      clearInterval(timer);
      samples.push(snapshot());
      const peak = samples.reduce((current, sample) => (
        sample.renderedItems > current.renderedItems ? sample : current
      ));
      const intervals = clickTimes.slice(1).map((time, index) => time - clickTimes[index]);
      return {
        clickEvents: clickTimes.length,
        clickEventIntervalsMilliseconds: intervals,
        initial: samples[0],
        peak,
        final: samples[samples.length - 1],
        samples,
      };
    },
  };
})()`;

async function loadCarousel(client, sessionId, url) {
  const loaded = client.waitFor('Page.loadEventFired', sessionId);
  await client.send('Page.navigate', { url }, sessionId);
  await loaded;
  await waitForCarousel(client, sessionId);

  return evaluate(client, sessionId, `(() => {
    const rect = document.querySelector('.right-arrow button').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
}

async function runCarouselTest(client, sessionId, url, fixture) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  }, sessionId);
  fixture.resetCoverRequests();
  let point = await loadCarousel(client, sessionId, url);
  await evaluate(client, sessionId, installProbeExpression);

  const dispatch = await dispatchClickBurst(client, sessionId, point);
  await wait(settleMilliseconds);
  const probe = await evaluate(client, sessionId, 'window.__carouselLagProbe.finish()');
  const measuredCoverRequests = fixture.getCoverRequests();
  const settledScreenshot = await captureScreenshot(client, sessionId);

  // Screenshot capture can pause the renderer. Reload before this visual-only
  // pass so it cannot affect the timings or DOM-window peak asserted above.
  point = await loadCarousel(client, sessionId, url);
  const visualBurst = dispatchClickBurst(client, sessionId, point);
  await wait(midBurstCaptureMilliseconds);
  const duringScreenshot = await captureScreenshot(client, sessionId);
  await visualBurst;

  return {
    dispatch,
    measuredCoverRequests,
    probe,
    screenshots: { duringScreenshot, settledScreenshot },
  };
}

async function runRightEdgeStress(client, sessionId, url, fixture) {
  const attempts = [];
  let terminalScreenshot = null;
  let emptyShelfObserved = false;
  const maximumAttempts = edgeClickIntervalsMilliseconds.length
    * edgeAttemptsPerInterval;

  edgeAttempts:
  for (const intervalMilliseconds of edgeClickIntervalsMilliseconds) {
    for (let cadenceAttempt = 1;
      cadenceAttempt <= edgeAttemptsPerInterval;
      cadenceAttempt += 1) {
      fixture.resetCoverRequests();
      const point = await loadCarousel(client, sessionId, url);
      await evaluate(client, sessionId, installProbeExpression);
      const dispatch = await dispatchClickBurst(client, sessionId, point, {
        count: edgeClickCount,
        intervalMilliseconds,
      });
      await wait(settleMilliseconds);
      const firstProbe = await evaluate(
        client,
        sessionId,
        'window.__carouselLagProbe.finish()',
      );
      await wait(250);
      const stableProbe = await evaluate(
        client,
        sessionId,
        'window.__carouselLagProbe.finish()',
      );
      const final = stableProbe.final;
      const stable = firstProbe.final.transform === final.transform
        && final.runningAnimations === 0;
      const emptyShelf = stable
        && final.rightArrowDisabled
        && final.paintedOnShelfItems === 0;
      const browserIntervals = stableProbe.clickEventIntervalsMilliseconds;
      attempts.push({
        attempt: attempts.length + 1,
        cadenceAttempt,
        intervalMilliseconds,
        dispatch,
        browserClickEvents: {
          count: stableProbe.clickEvents,
          minimumIntervalMilliseconds: Math.min(...browserIntervals),
          maximumIntervalMilliseconds: Math.max(...browserIntervals),
        },
        coverRequests: fixture.getCoverRequests(),
        peak: stableProbe.peak,
        final,
        stable,
        emptyShelf,
      });

      assert.ok(
        dispatch.maximumIntervalMilliseconds <= 50,
        `right-edge dispatch exceeded 50ms: ${dispatch.maximumIntervalMilliseconds}ms`,
      );
      assert.ok(final.rightArrowDisabled, 'right-edge stress must reach the disabled arrow');
      assert.ok(stable, 'right-edge stress must be sampled after animations stop');
      assert.ok(
        stableProbe.peak.renderedItems <= maximumRenderedItems,
        `right-edge window expanded to ${stableProbe.peak.renderedItems} items`,
      );
      assert.ok(
        fixture.getCoverRequests() <= maximumCoverRequests,
        `right-edge stress requested ${fixture.getCoverRequests()} covers`,
      );

      if (emptyShelf || attempts.length === maximumAttempts) {
        terminalScreenshot = await captureScreenshot(client, sessionId);
      }
      if (emptyShelf) {
        emptyShelfObserved = true;
        break edgeAttempts;
      }
    }
  }

  return { attempts, emptyShelfObserved, terminalScreenshot };
}

const fixture = await startSiteServer();
const temporarySiteRoot = mkdtempSync(path.join(tmpdir(), 'galata-carousel-lag-site-'));
const browser = launchChrome();
let client;

try {
  generateDevelopmentSite(temporarySiteRoot, fixture.url);
  fixture.load(temporarySiteRoot);
  client = await DevToolsClient.connect(await browser.websocketURL);
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, sessionId);
  await client.send('Runtime.enable', {}, sessionId);

  const result = await runCarouselTest(client, sessionId, fixture.url, fixture);
  const rightEdge = await runRightEdgeStress(client, sessionId, fixture.url, fixture);
  const browserIntervals = result.probe.clickEventIntervalsMilliseconds;
  const terminalEdgeAttempt = rightEdge.attempts.at(-1);
  const report = {
    configuration: {
      coverDelayMilliseconds,
      maximumCoverRequests,
      maximumRenderedItems,
      lag: {
        clickCount: lagClickCount,
        clickIntervalMilliseconds: lagClickIntervalMilliseconds,
      },
      rightEdge: {
        clickCount: edgeClickCount,
        clickIntervalsMilliseconds: edgeClickIntervalsMilliseconds,
        attemptsPerInterval: edgeAttemptsPerInterval,
      },
    },
    coverRequests: result.measuredCoverRequests,
    dispatch: result.dispatch,
    browserClickEvents: {
      count: result.probe.clickEvents,
      minimumIntervalMilliseconds: Math.min(...browserIntervals),
      maximumIntervalMilliseconds: Math.max(...browserIntervals),
    },
    initial: result.probe.initial,
    peak: result.probe.peak,
    final: result.probe.final,
    rightEdge: {
      emptyShelfObserved: rightEdge.emptyShelfObserved,
      attempts: rightEdge.attempts,
    },
  };

  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(path.join(reportDirectory, 'during-burst.png'), result.screenshots.duringScreenshot);
  writeFileSync(path.join(reportDirectory, 'settled.png'), result.screenshots.settledScreenshot);
  writeFileSync(
    path.join(reportDirectory, 'right-edge-terminal.png'),
    rightEdge.terminalScreenshot,
  );
  writeFileSync(path.join(reportDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

  assert.equal(result.dispatch.count, lagClickCount, 'every requested click must be dispatched');
  assert.ok(
    result.dispatch.maximumIntervalMilliseconds <= 50,
    `click dispatch exceeded 50ms: ${result.dispatch.maximumIntervalMilliseconds}ms`,
  );
  assert.equal(
    result.probe.clickEvents,
    lagClickCount,
    'Chrome must deliver every click to the arrow',
  );
  assert.ok(
    result.probe.peak.renderedItems <= maximumRenderedItems,
    `carousel window expanded to ${result.probe.peak.renderedItems} items`,
  );
  assert.ok(
    result.measuredCoverRequests <= maximumCoverRequests,
    `carousel requested ${result.measuredCoverRequests} covers`,
  );
  assert.equal(result.probe.final.visibleItems, 3, 'the carousel must recover to three visible covers');
  assert.ok(result.probe.final.renderedItems <= 5, 'the buffered carousel window must collapse');

  process.stdout.write([
    'Chrome carousel rapid-click regression passed.',
    `  clicks: ${result.probe.clickEvents} at ${lagClickIntervalMilliseconds}ms requested spacing`,
    '  actual dispatch spacing: '
      + `${result.dispatch.minimumIntervalMilliseconds.toFixed(1)}-`
      + `${result.dispatch.maximumIntervalMilliseconds.toFixed(1)}ms`,
    '  rendered items: '
      + `${result.probe.initial.renderedItems} initial -> `
      + `${result.probe.peak.renderedItems} peak -> `
      + `${result.probe.final.renderedItems} settled`,
    `  delayed cover requests: ${result.measuredCoverRequests}`,
    `  right-edge attempts at 25ms and 5ms: ${rightEdge.attempts.length}`,
    `  terminal covers on shelf: ${terminalEdgeAttempt.final.paintedOnShelfItems}`,
    `  empty terminal shelf observed: ${rightEdge.emptyShelfObserved ? 'yes' : 'no'}`,
    `  artifacts: ${reportDirectory}`,
    '',
  ].join('\n'));
} finally {
  client?.close();
  await browser.close();
  await new Promise((resolve) => fixture.server.close(resolve));
  rmSync(temporarySiteRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
