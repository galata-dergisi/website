#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const baseUrl = new URL(process.env.GALATA_CSP_BASE_URL || 'https://localhost');
const policyVariant = process.env.GALATA_CSP_VARIANT || 'production';
const suiteTimeoutMilliseconds = 90_000;
let activeBrowser;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(check, label, timeoutMilliseconds = 15_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  const suffix = lastError ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${label}${suffix}`);
}

function findChromium() {
  const candidates = [
    process.env.CHROME_BIN,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error('Chromium was not found in the browser image');
  return executable;
}

function launchChromium() {
  const profile = mkdtempSync(path.join(tmpdir(), 'galata-csp-browser-'));
  const chromium = spawn(findChromium(), [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--ignore-certificate-errors',
    '--allow-insecure-localhost',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  const websocketUrl = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Chromium DevTools endpoint timed out\n${stderr}`));
    }, 20_000);
    chromium.stderr.setEncoding('utf8');
    chromium.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-20_000);
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    chromium.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chromium exited before DevTools was ready (${code})\n${stderr}`));
    });
  });

  return {
    chromium,
    profile,
    websocketUrl,
    stderr: () => stderr,
    async close() {
      if (chromium.exitCode === null) {
        const exited = new Promise((resolve) => chromium.once('exit', resolve));
        chromium.kill('SIGTERM');
        await Promise.race([exited, delay(5_000)]);
        if (chromium.exitCode === null) chromium.kill('SIGKILL');
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
    this.listeners = new Map();
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
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    for (const listener of this.listeners.get(message.method) || []) {
      listener(message.params || {}, message.sessionId);
    }
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.websocket.send(JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }));
    });
  }

  waitFor(method, sessionId, timeoutMilliseconds = 15_000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMilliseconds);
      const unsubscribe = this.on(method, (params, eventSessionId) => {
        if (eventSessionId !== sessionId) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve(params);
      });
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
    throw new Error(
      response.exceptionDetails.exception?.description
        || response.exceptionDetails.text,
    );
  }
  return response.result.value;
}

function cspIssueDetails(issue) {
  return issue?.details?.contentSecurityPolicyIssueDetails || {};
}

function formatDiagnostics(diagnostics) {
  const issues = diagnostics.cspIssues.map((issue) => {
    const details = cspIssueDetails(issue);
    return `${details.violatedDirective || 'unknown directive'} blocked ${details.blockedURL || 'inline content'}`;
  });
  const blockedRequests = diagnostics.cspNetworkFailures.map((failure) => (
    `${failure.url || failure.requestId} (${failure.errorText || failure.blockedReason})`
  ));
  const exceptions = diagnostics.exceptions.map((exception) => (
    exception.exception?.description || exception.text || 'unknown exception'
  ));
  return [
    issues.length ? `CSP issues:\n- ${issues.join('\n- ')}` : '',
    blockedRequests.length ? `CSP-blocked requests:\n- ${blockedRequests.join('\n- ')}` : '',
    exceptions.length ? `Uncaught exceptions:\n- ${exceptions.join('\n- ')}` : '',
  ].filter(Boolean).join('\n');
}

function installDiagnostics(client, sessionId) {
  const diagnostics = {
    cspIssues: [],
    cspNetworkFailures: [],
    exceptions: [],
    requests: new Map(),
  };
  client.on('Audits.issueAdded', ({ issue }, eventSessionId) => {
    if (eventSessionId === sessionId && issue?.code === 'ContentSecurityPolicyIssue') {
      diagnostics.cspIssues.push(issue);
    }
  });
  client.on('Network.requestWillBeSent', ({ requestId, request }, eventSessionId) => {
    if (eventSessionId === sessionId) diagnostics.requests.set(requestId, request.url);
  });
  client.on('Network.loadingFailed', (failure, eventSessionId) => {
    if (eventSessionId !== sessionId || String(failure.blockedReason).toLowerCase() !== 'csp') {
      return;
    }
    diagnostics.cspNetworkFailures.push({
      ...failure,
      url: diagnostics.requests.get(failure.requestId),
    });
  });
  client.on('Runtime.exceptionThrown', ({ exceptionDetails }, eventSessionId) => {
    if (eventSessionId === sessionId) diagnostics.exceptions.push(exceptionDetails);
  });
  return diagnostics;
}

async function navigate(client, sessionId, route) {
  const loaded = client.waitFor('Page.loadEventFired', sessionId);
  const result = await client.send('Page.navigate', {
    url: new URL(route, baseUrl).href,
  }, sessionId);
  if (result.errorText) throw new Error(`Navigation to ${route} failed: ${result.errorText}`);
  await loaded;
  await waitFor(
    () => evaluate(client, sessionId, 'document.readyState === "complete"'),
    `${route} document readiness`,
  );
}

async function acceptHomepage(client, sessionId) {
  await navigate(client, sessionId, '/');
  await waitFor(
    () => evaluate(client, sessionId, `(() => {
      const items = document.querySelector('.carousel .items');
      const arrow = document.querySelector('.right-arrow button');
      return Boolean(items && arrow && !arrow.disabled);
    })()`),
    'homepage hydration',
  );

  const transformBefore = await evaluate(
    client,
    sessionId,
    'document.querySelector(".carousel .items").style.transform',
  );
  await evaluate(client, sessionId, 'document.querySelector(".right-arrow button").click()');
  await waitFor(
    async () => (await evaluate(
      client,
      sessionId,
      'document.querySelector(".carousel .items").style.transform',
    )) !== transformBefore,
    'carousel movement',
  );

  const apiResult = await evaluate(client, sessionId, `(async () => {
    const response = await fetch('/magazines', { cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  })()`);
  assert.equal(apiResult.status, 200, 'same-origin magazine API must respond');
  assert.equal(apiResult.body.success, true, 'same-origin magazine API payload must succeed');

  await waitFor(
    () => evaluate(client, sessionId, `Array.from(document.images)
      .some((image) => image.complete && image.naturalWidth > 0)`),
    'same-origin homepage image',
  );
  const assets = await evaluate(client, sessionId, `(async () => {
    await document.fonts.load('16px akaDora', 'Galata');
    await document.fonts.ready;
    const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
    return {
      fontLoaded: document.fonts.check('16px akaDora', 'Galata'),
      fontRequested: resources.some((url) => new URL(url).pathname === '/fonts/akaDora.woff2'),
      loadedImages: Array.from(document.images).filter((image) => (
        image.src.startsWith(location.origin) && image.complete && image.naturalWidth > 0
      )).length,
    };
  })()`);
  assert.equal(assets.fontLoaded, true, 'same-origin font must load under CSP');
  assert.equal(assets.fontRequested, true, 'font acceptance must exercise a font request');
  assert.ok(assets.loadedImages > 0, 'same-origin images must load under CSP');

  const serviceWorker = await evaluate(client, sessionId, `(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('service worker readiness timed out')),
        20_000,
      )),
    ]);
    return {
      supported: true,
      active: Boolean(registration.active),
      scope: registration.scope,
    };
  })()`);
  assert.equal(serviceWorker.supported, true, 'Chromium must support service workers');
  assert.equal(serviceWorker.active, true, 'same-origin service worker must activate');
  assert.equal(serviceWorker.scope, `${baseUrl.origin}/`);
}

async function acceptLegacyVideo(client, sessionId) {
  await navigate(client, sessionId, '/dergiler/sayi45/34');
  await waitFor(
    () => evaluate(client, sessionId, `Boolean(
      document.querySelector('.video-play-button')
      && document.querySelector('.video-mask')
      && document.querySelector('.back-video')
    )`),
    'legacy video page',
  );
  const externalAssets = await evaluate(client, sessionId, `({
    stylesheet: Boolean(document.querySelector(
      'link[href^="/assets/legacy/sayi45-page34.css?v="]'
    )),
    script: Boolean(document.querySelector(
      'script[src^="/assets/legacy/sayi45-page34.js?v="]'
    )),
  })`);
  assert.equal(externalAssets.stylesheet, true, 'legacy video stylesheet must be external');
  assert.equal(externalAssets.script, true, 'legacy video script must be external');

  await delay(50);
  await evaluate(client, sessionId, 'document.querySelector(".video-play-button").click()');
  await waitFor(
    () => evaluate(client, sessionId, `document.querySelector('.video-play-button').classList.contains('hide')
      && document.querySelector('.video-mask').classList.contains('hide')
      && window.__galataCspTestMediaPlayCalls > 0`),
    'legacy external video handler',
  );
}

async function acceptContributorSearch(client, sessionId) {
  await navigate(client, sessionId, '/katkida-bulunanlar/15-nafizcan-onder');
  await waitFor(
    () => evaluate(client, sessionId, `Boolean(
      document.querySelector('.profile-search:not([hidden])')
      && document.querySelector('#katki-arama')
      && document.querySelectorAll('.contribution-row').length
    )`),
    'contributor profile search enhancement',
  );
  const externalAssets = await evaluate(client, sessionId, `({
    stylesheet: Boolean(document.querySelector(
      'link[href^="/assets/contributor-profile.css?v="]'
    )),
    script: Boolean(document.querySelector(
      'script[src^="/assets/contributor-profile.js?v="]'
    )),
  })`);
  assert.equal(externalAssets.stylesheet, true, 'contributor stylesheet must be external');
  assert.equal(externalAssets.script, true, 'contributor script must be external');

  const filtered = await evaluate(client, sessionId, `(() => {
    const input = document.querySelector('#katki-arama');
    input.value = '__galata_csp_no_match__';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      visibleRows: Array.from(document.querySelectorAll('.contribution-row'))
        .filter((row) => !row.hidden).length,
      emptyVisible: !document.querySelector('.profile-search-empty').hidden,
      status: document.querySelector('#katki-arama-durumu').textContent,
    };
  })()`);
  assert.equal(filtered.visibleRows, 0, 'profile search must filter contribution rows');
  assert.equal(filtered.emptyVisible, true, 'profile search must reveal its empty state');
  assert.match(filtered.status, /^0 eşleşme$/);
}

async function acceptAudioPlayer(client, sessionId) {
  await navigate(client, sessionId, '/dergiler/sayi46/58');
  await waitFor(
    () => evaluate(client, sessionId, `Boolean(
      document.querySelector('[data-audio-player-view] .player_volume_button')
    )`),
    'hydrated audio controls',
  );
  const before = await evaluate(client, sessionId, `(() => {
    const player = document.querySelector('[data-audio-player-view]');
    return {
      label: player.querySelector('.player_volume_button').getAttribute('aria-label'),
      volumeStyle: player.querySelector('.player_volume_current').getAttribute('style'),
      dynamicStyles: player.querySelectorAll('[style]').length,
    };
  })()`);
  assert.equal(before.label, 'Sesi kapat');
  assert.ok(before.dynamicStyles > 0, 'audio player must retain reviewed dynamic style attributes');
  assert.match(before.volumeStyle, /width:/);

  await evaluate(
    client,
    sessionId,
    'document.querySelector("[data-audio-player-view] .player_volume_button").click()',
  );
  await waitFor(
    () => evaluate(client, sessionId, `(() => {
      const player = document.querySelector('[data-audio-player-view]');
      return player.querySelector('.player_volume_button').getAttribute('aria-label') === 'Sesi aç'
        && parseFloat(player.querySelector('.player_volume_current').style.width) === 0;
    })()`),
    'audio mute state and dynamic style update',
  );
}

function directiveMatches(issue, expectedDirectives) {
  const directive = cspIssueDetails(issue).violatedDirective || '';
  return expectedDirectives.some((expected) => (
    directive === expected || directive.startsWith(`${expected} `)
  ));
}

async function expectCspProbe({
  client,
  diagnostics,
  expression,
  expectedDirectives,
  label,
  sessionId,
  verify,
}) {
  const issueStart = diagnostics.cspIssues.length;
  const result = await evaluate(client, sessionId, expression);
  verify(result);
  await waitFor(
    () => diagnostics.cspIssues.slice(issueStart)
      .some((issue) => directiveMatches(issue, expectedDirectives)),
    `${label} CSP issue`,
    5_000,
  );
}

async function runNegativeProbes(client, sessionId, diagnostics) {
  await expectCspProbe({
    client,
    sessionId,
    diagnostics,
    label: 'inline script',
    expectedDirectives: ['script-src-elem', 'script-src'],
    expression: `(async () => {
      window.__galataInlineScriptRan = false;
      const script = document.createElement('script');
      script.textContent = 'window.__galataInlineScriptRan = true';
      document.body.append(script);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { ran: window.__galataInlineScriptRan };
    })()`,
    verify: (result) => assert.equal(result.ran, false, 'inline script must not execute'),
  });

  await expectCspProbe({
    client,
    sessionId,
    diagnostics,
    label: 'inline event handler',
    expectedDirectives: ['script-src-attr'],
    expression: `(async () => {
      window.__galataInlineHandlerRan = false;
      const button = document.createElement('button');
      button.setAttribute('onclick', 'window.__galataInlineHandlerRan = true');
      document.body.append(button);
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { ran: window.__galataInlineHandlerRan };
    })()`,
    verify: (result) => assert.equal(result.ran, false, 'inline handler must not execute'),
  });

  await expectCspProbe({
    client,
    sessionId,
    diagnostics,
    label: 'frame',
    expectedDirectives: ['frame-src'],
    expression: `(async () => {
      const frame = document.createElement('iframe');
      frame.src = '/?galata-csp-frame-probe=1';
      document.body.append(frame);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { loadedApp: Boolean(frame.contentDocument?.querySelector('#app')) };
    })()`,
    verify: (result) => assert.equal(result.loadedApp, false, 'forbidden frame must not load'),
  });

  await expectCspProbe({
    client,
    sessionId,
    diagnostics,
    label: 'object',
    expectedDirectives: ['object-src'],
    expression: `(async () => {
      const object = document.createElement('object');
      object.type = 'image/svg+xml';
      object.data = '/images/header-logo.svg?galata-csp-object-probe=1';
      document.body.append(object);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { loaded: Boolean(object.contentDocument) };
    })()`,
    verify: (result) => assert.equal(result.loaded, false, 'forbidden object must not load'),
  });

  await expectCspProbe({
    client,
    sessionId,
    diagnostics,
    label: 'external connection',
    expectedDirectives: ['connect-src'],
    expression: `(async () => {
      try {
        await fetch('https://example.invalid/galata-csp-connect-probe');
        return { rejected: false };
      } catch (error) {
        return { rejected: true, name: error.name };
      }
    })()`,
    verify: (result) => assert.equal(result.rejected, true, 'external fetch must be rejected'),
  });

  await expectCspProbe({
    client,
    sessionId,
    diagnostics,
    label: 'base URI',
    expectedDirectives: ['base-uri'],
    expression: `(async () => {
      const before = document.baseURI;
      const base = document.createElement('base');
      base.href = 'https://example.invalid/galata-csp-base-probe/';
      document.head.prepend(base);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { before, after: document.baseURI };
    })()`,
    verify: (result) => assert.equal(
      result.after,
      result.before,
      'forbidden base URI must not change URL resolution',
    ),
  });

  const styleIssueStart = diagnostics.cspIssues.length;
  const styleResult = await evaluate(client, sessionId, `(async () => {
    const element = document.createElement('div');
    element.style.width = '37px';
    element.style.height = '11px';
    document.body.append(element);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      attribute: element.getAttribute('style'),
      width: getComputedStyle(element).width,
    };
  })()`);
  assert.match(styleResult.attribute, /width: 37px/);
  assert.equal(styleResult.width, '37px', 'reviewed inline style attributes must remain effective');
  await delay(250);
  assert.equal(
    diagnostics.cspIssues.slice(styleIssueStart)
      .some((issue) => directiveMatches(issue, ['style-src-attr'])),
    false,
    'style-src-attr exception must not report a violation',
  );
}

async function runSuite() {
  const browser = launchChromium();
  activeBrowser = browser;
  let client;
  try {
    client = await DevToolsClient.connect(await browser.websocketUrl);
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await client.send('Page.enable', {}, sessionId);
    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Network.enable', {}, sessionId);
    await client.send('Audits.enable', {}, sessionId);
    await client.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__galataCspTestMediaPlayCalls = 0;
        HTMLMediaElement.prototype.play = function playForCspAcceptance() {
          window.__galataCspTestMediaPlayCalls += 1;
          return Promise.resolve();
        };
      `,
    }, sessionId);
    const diagnostics = installDiagnostics(client, sessionId);

    await acceptHomepage(client, sessionId);
    await acceptLegacyVideo(client, sessionId);
    await acceptContributorSearch(client, sessionId);
    await acceptAudioPlayer(client, sessionId);
    await delay(250);

    assert.equal(
      diagnostics.cspIssues.length,
      0,
      `application CSP violations occurred before negative probes\n${formatDiagnostics(diagnostics)}`,
    );
    assert.equal(
      diagnostics.cspNetworkFailures.length,
      0,
      `application requests were blocked by CSP before negative probes\n${formatDiagnostics(diagnostics)}`,
    );
    assert.equal(
      diagnostics.exceptions.length,
      0,
      `uncaught page exceptions occurred before negative probes\n${formatDiagnostics(diagnostics)}`,
    );

    const negativeIssueStart = diagnostics.cspIssues.length;
    await runNegativeProbes(client, sessionId, diagnostics);
    assert.equal(
      diagnostics.exceptions.length,
      0,
      `negative CSP probes caused uncaught exceptions\n${formatDiagnostics(diagnostics)}`,
    );
    const reviewedDirectives = new Set([
      'base-uri',
      'connect-src',
      'frame-src',
      'object-src',
      'script-src',
      'script-src-attr',
      'script-src-elem',
    ]);
    for (const issue of diagnostics.cspIssues.slice(negativeIssueStart)) {
      const directive = cspIssueDetails(issue).violatedDirective;
      assert.ok(
        reviewedDirectives.has(directive),
        `negative probe produced an unexpected CSP directive: ${directive}`,
      );
    }

    process.stdout.write(
      `${policyVariant} enforced CSP browser acceptance passed (${diagnostics.cspIssues.length} expected negative-probe issues).\n`,
    );
  } catch (error) {
    const browserLog = browser.stderr();
    if (browserLog) error.message = `${error.message}\nChromium stderr:\n${browserLog}`;
    throw error;
  } finally {
    client?.close();
    await browser.close();
    if (activeBrowser === browser) activeBrowser = undefined;
  }
}

let suiteTimeout;
try {
  await Promise.race([
    runSuite(),
    new Promise((_, reject) => {
      suiteTimeout = setTimeout(async () => {
        await activeBrowser?.close();
        reject(new Error(`CSP browser suite exceeded ${suiteTimeoutMilliseconds}ms`));
      }, suiteTimeoutMilliseconds);
    }),
  ]);
} finally {
  clearTimeout(suiteTimeout);
}
