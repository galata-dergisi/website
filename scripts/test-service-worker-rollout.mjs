#!/usr/bin/env node

import assert from 'assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  FakeCacheStorage,
  ServiceWorkerHarness,
  makeRequest,
} from './lib/service-worker-test-harness.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const origin = 'https://galatadergisi.org';
const legacyCacheName = 'galatadergisi-cache-v21';
const legacyWorkerFile = path.join(
  projectRoot,
  'tests/fixtures/service-worker-main-v21.js',
);
const devWorkerFile = path.join(projectRoot, 'public/service-worker.js');
const generatedRoot = path.join(projectRoot, 'internal/site/dist');
const generatedManifestFile = path.join(generatedRoot, 'manifest.json');
const expectedLegacyWorkerHash = 'ab7559f634212780c1cc8c8a7a122ba1e6bffc9e1e1624d75c0a7d3e17b6edf4';

const legacyWorkerSource = fs.readFileSync(legacyWorkerFile, 'utf8');
const devWorkerSource = fs.readFileSync(devWorkerFile, 'utf8');
const generatedManifest = JSON.parse(fs.readFileSync(generatedManifestFile, 'utf8'));
assert.equal(
  generatedManifest.routes['/legacy-player.js'],
  undefined,
  'the modern release must not publish the legacy player runtime',
);

assert.equal(
  crypto.createHash('sha256').update(legacyWorkerSource).digest('hex'),
  expectedLegacyWorkerHash,
  'main-v21 worker fixture must remain byte-identical to deployed commit ca4b1d6',
);

const directShellPaths = new Set([
  '/bundle.css',
  '/bundle.js',
  '/global.css',
  '/legacy-player.js',
  '/images/favicon.png',
]);

function responseForRelease(content, release, contentType = 'text/plain') {
  return new Response(content, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'X-Test-Release': release,
    },
  });
}

function readGeneratedRoute(pathname) {
  const entry = generatedManifest.routes[pathname];
  if (!entry) return null;
  return {
    content: fs.readFileSync(path.join(generatedRoot, entry.file)),
    contentType: entry.contentType,
  };
}

function devNetwork({ failPath = null } = {}) {
  return async (request) => {
    const url = new URL(request.url || request, origin);
    if (url.pathname === failPath) throw new Error(`offline:${url.pathname}`);
    const route = readGeneratedRoute(url.pathname);
    if (!route) return new Response('not found', { status: 404 });
    return responseForRelease(route.content, 'dev', route.contentType);
  };
}

function legacyNetwork(request) {
  const url = new URL(request.url || request, origin);
  return responseForRelease(`main:${url.pathname}`, 'main');
}

function shellURLs(html) {
  const result = [];
  const pattern = /<(?:link|script)\b[^>]*(?:href|src)="([^"]+)"[^>]*>/gi;
  for (const match of html.matchAll(pattern)) {
    const url = new URL(match[1], origin);
    if (url.origin === origin && directShellPaths.has(url.pathname)) {
      result.push(`${url.pathname}${url.search}`);
    }
  }
  return result;
}

async function collectDocumentMismatches(worker, pathname, scenario) {
  const documentResponse = await worker.handleRequest(
    makeRequest(pathname, { mode: 'navigate' }, origin),
  );
  const expectedRelease = documentResponse.headers.get('X-Test-Release');
  const html = await documentResponse.text();
  const urls = shellURLs(html);
  assert.ok(urls.length > 0, `${scenario} must load local shell assets`);

  const mismatches = [];
  for (const url of urls) {
    const response = await worker.handleRequest(url);
    const actualRelease = response.headers.get('X-Test-Release');
    if (actualRelease !== expectedRelease) {
      mismatches.push({
        scenario,
        document: expectedRelease,
        asset: actualRelease,
        url,
      });
    }
  }
  return mismatches;
}

async function legacySession({
  cachedDocument = null,
} = {}) {
  const storage = new FakeCacheStorage({ origin, networkFetch: legacyNetwork });
  const worker = new ServiceWorkerHarness(legacyWorkerSource, {
    filename: legacyWorkerFile,
    origin,
    storage,
  });
  worker.assertListeners();
  await worker.install();

  if (cachedDocument) {
    await storage.seed(
      legacyCacheName,
      '/',
      responseForRelease(cachedDocument, 'main', 'text/html; charset=utf-8'),
    );
  }
  storage.setNetworkFetch(devNetwork());
  return { storage, worker };
}

const mismatches = [];
const lifecycleFailures = [];

{
  const { worker } = await legacySession();
  mismatches.push(...await collectDocumentMismatches(
    worker,
    '/',
    'legacy worker with uncached homepage',
  ));
}

{
  const { worker } = await legacySession();
  mismatches.push(...await collectDocumentMismatches(
    worker,
    '/dergiler/sayi47/10',
    'legacy worker with uncached reader deep link',
  ));
}

const cachedMainDocument = `<!doctype html><html><head>
  <link rel="icon" href="/images/favicon.png">
  <link rel="stylesheet" href="/global.css">
  <link rel="stylesheet" href="/bundle.css">
  <script src="/legacy-player.js"></script>
  <script defer src="/bundle.js"></script>
</head><body></body></html>`;

{
  const { storage, worker: legacyWorker } = await legacySession({
    cachedDocument: cachedMainDocument,
  });
  mismatches.push(...await collectDocumentMismatches(
    legacyWorker,
    '/',
    'cached main document before activation',
  ));

  const devWorker = new ServiceWorkerHarness(devWorkerSource, {
    filename: devWorkerFile,
    origin,
    storage,
  });
  devWorker.assertListeners();
  await devWorker.install();
  if (devWorker.skipWaitingCalled) {
    lifecycleFailures.push('dev worker skipped waiting while main clients were active');
  }
  assert.ok(
    storage.cacheStores.has(legacyCacheName),
    'installing dev worker must preserve the active main cache',
  );

  await devWorker.activate();
  assert.ok(devWorker.clientsClaimed, 'activated dev worker must claim new clients');
  assert.ok(
    !storage.cacheStores.has(legacyCacheName),
    'dev activation must remove the obsolete main cache',
  );
  mismatches.push(...await collectDocumentMismatches(
    devWorker,
    '/',
    'first navigation after dev activation',
  ));
  const upgradedDocument = await devWorker.handleRequest(
    makeRequest('/', { mode: 'navigate' }, origin),
  );
  assert.doesNotMatch(
    await upgradedDocument.text(),
    /\/legacy-player\.js/,
    'the first post-activation shell must advance past the cached legacy runtime',
  );
}

{
  const { storage } = await legacySession();
  storage.setNetworkFetch(devNetwork({ failPath: '/bundle.js' }));
  const devWorker = new ServiceWorkerHarness(devWorkerSource, {
    filename: devWorkerFile,
    origin,
    storage,
  });
  await assert.rejects(devWorker.install(), /offline:\/bundle\.js/);
  assert.ok(
    storage.cacheStores.has(legacyCacheName),
    'failed dev installation must leave the main cache intact',
  );
  assert.equal(devWorker.clientsClaimed, false, 'failed installation must not claim clients');
}

{
  const storage = new FakeCacheStorage({ origin, networkFetch: devNetwork() });
  const devWorker = new ServiceWorkerHarness(devWorkerSource, {
    filename: devWorkerFile,
    origin,
    storage,
  });
  await devWorker.install();
  await devWorker.activate();
  mismatches.push(...await collectDocumentMismatches(
    devWorker,
    '/',
    'fresh dev client',
  ));
}

assert.deepEqual(
  { mismatches, lifecycleFailures },
  { mismatches: [], lifecycleFailures: [] },
  'service-worker rollout must never mix releases or replace active main clients',
);

process.stdout.write('Main-v21 to dev service-worker rollout scenarios passed.\n');
