#!/usr/bin/env node
// Copyright 2026 Mehmet Baker
//
// Full-stack local development orchestrator.

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import { once } from 'events';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, '..');
const publicRoot = path.join(repoRoot, 'public');
const frontendBuilder = path.join(repoRoot, 'scripts', 'build-frontend.mjs');
const defaultMediaRoot = path.resolve(
  repoRoot,
  '..',
  'galata-dergisi-static-assets',
  'server-assets',
  'public',
);
const developmentSiteRoot = path.join(repoRoot, 'build', 'dev-sites');
const developmentBinaryRoot = path.join(repoRoot, 'build', 'dev-binaries');
const carouselSheetGenerator = path.join(
  repoRoot,
  'scripts',
  'generate-carousel-sheet.mjs',
);
const carouselSheetWatchPaths = [
  path.join(repoRoot, 'client', 'images', 'sayi*', 'thumbnail.jpg'),
  path.join(
    repoRoot,
    'client',
    'pages',
    'homepage',
    'components',
    'carousel-placeholder.mjs',
  ),
  carouselSheetGenerator,
];
const frontendReadyMessage = 'galata-frontend-ready';
const childEnvironment = { ...process.env };
const commandChildren = new Set();
let shutdownRequested = false;

function fail(message) {
  throw new Error(message);
}

function optionValue(arguments_, index, name) {
  const argument = arguments_[index];
  const inline = argument.indexOf('=');
  if (inline !== -1) return { value: argument.slice(inline + 1), consumed: 0 };
  if (index + 1 >= arguments_.length || arguments_[index + 1].startsWith('--')) {
    fail(`${name} requires a value`);
  }
  return { value: arguments_[index + 1], consumed: 1 };
}

function configuredDevelopmentPort(environment) {
  const value = environment.LISTEN_ADDR;
  if (value === undefined) return 3000;
  const match = /^127\.0\.0\.1:([0-9]+)$/.exec(value.trim());
  if (!match) {
    fail('LISTEN_ADDR must use 127.0.0.1:<port> in development');
  }
  return Number(match[1]);
}

function configuredDevelopmentPath(environment, name, fallback) {
  const value = environment[name];
  if (value === undefined) return fallback;
  if (value.trim() === '') fail(`${name} must not be empty`);
  return path.resolve(repoRoot, value);
}

export function parseDevelopmentOptions(arguments_, environment = process.env) {
  const options = {
    port: 3000,
    mediaRoot: defaultMediaRoot,
    contributionsDir: path.join(repoRoot, 'contributions'),
  };
  const configured = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--') continue;
    const name = argument.split('=', 1)[0];
    if (!['--port', '--media-root', '--contributions-dir'].includes(name)) {
      fail(`Unknown development option: ${argument}`);
    }
    const { value, consumed } = optionValue(arguments_, index, name);
    index += consumed;
    if (name === '--port') {
      if (!/^[0-9]+$/.test(value)) fail('--port must be an integer');
      options.port = Number(value);
      configured.add('port');
    } else if (name === '--media-root') {
      options.mediaRoot = path.resolve(repoRoot, value);
      configured.add('mediaRoot');
    } else {
      options.contributionsDir = path.resolve(repoRoot, value);
      configured.add('contributionsDir');
    }
  }
  if (!configured.has('port')) {
    options.port = configuredDevelopmentPort(environment);
  }
  if (!configured.has('mediaRoot')) {
    options.mediaRoot = configuredDevelopmentPath(
      environment,
      'EXTERNAL_MEDIA_DIR',
      defaultMediaRoot,
    );
  }
  if (!configured.has('contributionsDir')) {
    options.contributionsDir = configuredDevelopmentPath(
      environment,
      'CONTRIBUTIONS_DIR',
      path.join(repoRoot, 'contributions'),
    );
  }
  if (options.port < 1 || options.port > 65535) {
    fail('development port must be between 1 and 65535');
  }
  return options;
}

function pinnedVersion(filename) {
  return fs.readFileSync(path.join(repoRoot, filename), 'utf8').trim().replace(/^v/, '');
}

function assertExactToolchain() {
  const expectedNode = pinnedVersion('.nvmrc');
  if (process.versions.node !== expectedNode) {
    fail([
      `Node ${expectedNode} is required; currently running ${process.versions.node}.`,
      'Run `nvm install` and `nvm use`, then retry `npm run dev`.',
    ].join('\n'));
  }

  const expectedGo = pinnedVersion('.go-version');
  const result = spawnSync('go', ['version'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.error) {
    fail(`Go ${expectedGo} is required, but the go command is unavailable.`);
  }
  const match = String(result.stdout).match(/\bgo([0-9]+\.[0-9]+(?:\.[0-9]+)?)\b/);
  const actualGo = match ? match[1] : 'unknown';
  if (result.status !== 0 || actualGo !== expectedGo) {
    fail([
      `Go ${expectedGo} is required; currently running ${actualGo}.`,
      'Install the version from `.go-version`, ensure it is first on PATH, and retry.',
    ].join('\n'));
  }
}

function log(message) {
  process.stdout.write(`[galata-dev] ${message}\n`);
}

function run(command, arguments_, { label, env = {}} = {}) {
  if (label) log(label);
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repoRoot,
      env: { ...childEnvironment, ...env },
      stdio: 'inherit',
    });
    commandChildren.add(child);
    child.once('error', (error) => {
      commandChildren.delete(child);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      commandChildren.delete(child);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `${label || command} failed${signal ? ` with ${signal}` : ` (exit ${code})`}`,
      ));
    });
  });
}

function runNode(arguments_, options) {
  return run(process.execPath, arguments_, options);
}

async function generateCarouselSheet() {
  await runNode([carouselSheetGenerator], {
    label: 'generating carousel sheet',
  });
}

let generationSequence = 0;
function nextGenerationToken() {
  generationSequence += 1;
  return [
    Date.now().toString(36),
    generationSequence.toString(36),
    crypto.randomBytes(4).toString('hex'),
  ].join('-');
}

function developmentUrl(port) {
  return `http://127.0.0.1:${port}`;
}

function fileDigest(filename) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  } catch {
    return null;
  }
}

async function validateMedia(options) {
  await runNode([
    path.join(repoRoot, 'scripts', 'validate-development-media.js'),
    options.mediaRoot,
    path.join(repoRoot, 'content', 'public.sqlite'),
  ], {
    label: 'validating catalog media',
  });
}

async function generateSite(token, options) {
  const siteRoot = path.join(developmentSiteRoot, token);
  const baseUrl = developmentUrl(options.port);
  try {
    await runNode([
      path.join(repoRoot, 'scripts', 'generate-site.js'),
      '--mode', 'development',
      '--database', path.join(repoRoot, 'content', 'public.sqlite'),
      '--output', siteRoot,
      '--base-url', baseUrl,
      '--generation-token', token,
    ], {
      label: `generating development site ${token}`,
    });
    await runNode([
      path.join(repoRoot, 'scripts', 'verify-generated-site.js'),
      siteRoot,
      baseUrl,
    ], {
      label: 'verifying generated development site',
    });
    return siteRoot;
  } catch (error) {
    fs.rmSync(siteRoot, { recursive: true, force: true });
    throw error;
  }
}

async function buildDevelopmentBinary(token) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const filename = path.join(developmentBinaryRoot, `galata-dev-${token}${suffix}`);
  fs.mkdirSync(developmentBinaryRoot, { recursive: true });
  try {
    await run('go', [
      'build',
      '-o', filename,
      './cmd/galata-dev',
    ], {
      label: 'building Go development server',
    });
    return filename;
  } catch (error) {
    fs.rmSync(filename, { force: true });
    throw error;
  }
}

function serverArguments(candidate, options) {
  return [
    '--port', String(options.port),
    '--site-root', candidate.siteRoot,
    '--public-root', publicRoot,
    '--media-root', options.mediaRoot,
    '--contributions-dir', options.contributionsDir,
    '--generation-token', candidate.generation,
    '--server-token', candidate.serverToken,
  ];
}

function startServer(candidate, options) {
  return spawn(candidate.binary, serverArguments(candidate, options), {
    cwd: repoRoot,
    env: childEnvironment,
    stdio: 'inherit',
  });
}

export function waitForFrontendReady(child) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    }
    function onMessage(message) {
      if (message?.type !== frontendReadyMessage) return;
      cleanup();
      resolve();
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onExit(code, signal) {
      cleanup();
      reject(new Error(
        `Vite watcher stopped before becoming ready (${signal || code})`,
      ));
    }
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function readDevelopmentStatus(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/__dev/status',
      headers: { 'Cache-Control': 'no-store' },
      timeout: 500,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`development status returned ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('timeout', () => request.destroy(new Error('status request timed out')));
    request.once('error', reject);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitUntilHealthy(child, candidate, port) {
  const deadline = Date.now() + 8000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`development server exited with code ${child.exitCode}`);
    }
    try {
      const status = await readDevelopmentStatus(port);
      if (
        status.generation === candidate.generation
        && status.server === candidate.serverToken
      ) return;
      lastError = new Error('another process is using the development port');
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`development server did not become healthy: ${lastError?.message || 'timeout'}`);
}

const intentionallyStopped = new WeakSet();

async function stopChild(child, timeout = 5000) {
  if (!child || child.exitCode !== null) return;
  intentionallyStopped.add(child);
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const completed = await Promise.race([
    exited.then(() => true),
    delay(timeout).then(() => false),
  ]);
  if (!completed && child.exitCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

function removeVersionedArtifact(filename, expectedParent) {
  if (!filename) return;
  const parent = path.resolve(expectedParent);
  const target = path.resolve(filename);
  if (target !== parent && target.startsWith(`${parent}${path.sep}`)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseDevelopmentOptions(process.argv.slice(2));
  assertExactToolchain();
  const { default: chokidar } = await import('chokidar');

  let active = null;
  let serverChild = null;
  let frontendBuildChild = null;
  let stopping = false;
  let shutdownPromise = null;
  const watchers = [];

  function monitorServer(child) {
    child.once('exit', (code, signal) => {
      if (!stopping && !intentionallyStopped.has(child)) {
        process.stderr.write(
          `[galata-dev] server stopped unexpectedly (${signal || code})\n`,
        );
        void shutdown(1);
      }
    });
  }

  async function activate(candidate) {
    const previous = active;
    await stopChild(serverChild);
    serverChild = startServer(candidate, options);
    try {
      await waitUntilHealthy(serverChild, candidate, options.port);
    } catch (error) {
      await stopChild(serverChild);
      serverChild = null;
      if (previous) {
        log('new server failed to start; restoring the last healthy generation');
        serverChild = startServer(previous, options);
        await waitUntilHealthy(serverChild, previous, options.port);
        monitorServer(serverChild);
      }
      throw error;
    }
    monitorServer(serverChild);
    active = candidate;
    if (previous && previous.siteRoot !== candidate.siteRoot) {
      removeVersionedArtifact(previous.siteRoot, developmentSiteRoot);
    }
    if (previous && previous.binary !== candidate.binary) {
      removeVersionedArtifact(previous.binary, developmentBinaryRoot);
    }
  }

  async function shutdown(code = 0) {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
      await Promise.all(watchers.map((watcher) => watcher.close()));
      await Promise.all([...commandChildren].map((child) => stopChild(child)));
      await stopChild(frontendBuildChild);
      await stopChild(serverChild);
      process.exitCode = code;
    })();
    return shutdownPromise;
  }

  process.once('SIGINT', () => {
    shutdownRequested = true;
    log('shutdown requested');
    void shutdown(0);
  });
  process.once('SIGTERM', () => {
    shutdownRequested = true;
    log('shutdown requested');
    void shutdown(0);
  });

  fs.mkdirSync(developmentSiteRoot, { recursive: true });
  fs.mkdirSync(developmentBinaryRoot, { recursive: true });

  await generateCarouselSheet();
  await runNode([frontendBuilder, '--development'], {
    label: 'building unminified browser and SSR assets',
  });

  const initialToken = nextGenerationToken();
  const initialSiteRoot = await generateSite(initialToken, options);
  await validateMedia(options);
  const initialBinary = await buildDevelopmentBinary(initialToken);
  if (stopping) return;

  await activate({
    generation: initialToken,
    serverToken: initialToken,
    siteRoot: initialSiteRoot,
    binary: initialBinary,
  });

  const pending = new Set();
  let rebuildTimer = null;
  let rebuilding = false;

  async function drainRebuilds() {
    if (rebuilding || stopping) return;
    rebuilding = true;
    try {
      while (pending.size && !stopping) {
        const layers = new Set(pending);
        pending.clear();
        if (layers.size === 1 && layers.has('media')) {
          try {
            await validateMedia(options);
          } catch (error) {
            process.stderr.write(`[galata-dev] ${error.message}\n`);
          }
          continue;
        }
        if (layers.size === 1 && layers.has('carousel')) {
          try {
            await generateCarouselSheet();
          } catch (error) {
            process.stderr.write(`[galata-dev] ${error.message}\n`);
          }
          continue;
        }

        const token = nextGenerationToken();
        let generatedSiteRoot = null;
        let siteRoot = active.siteRoot;
        let generation = active.generation;
        let binary = active.binary;
        try {
          if (layers.has('carousel')) {
            await generateCarouselSheet();
          }
          if (layers.has('site') || layers.has('media')) {
            await validateMedia(options);
          }
          if (layers.has('site')) {
            generatedSiteRoot = await generateSite(token, options);
            siteRoot = generatedSiteRoot;
            generation = token;
          }
          if (layers.has('go')) {
            binary = await buildDevelopmentBinary(token);
          }
          await activate({
            generation,
            serverToken: token,
            siteRoot,
            binary,
          });
          log(`rebuild recovered and is healthy (${[...layers].sort().join(', ')})`);
        } catch (error) {
          if (generatedSiteRoot && generatedSiteRoot !== active?.siteRoot) {
            removeVersionedArtifact(generatedSiteRoot, developmentSiteRoot);
          }
          if (binary && binary !== active?.binary) {
            removeVersionedArtifact(binary, developmentBinaryRoot);
          }
          process.stderr.write(
            `[galata-dev] rebuild failed; the last healthy server is still running\n${error.stack || error}\n`,
          );
        }
      }
    } finally {
      rebuilding = false;
      if (pending.size && !stopping) void drainRebuilds();
    }
  }

  function schedule(layer) {
    if (stopping) return;
    pending.add(layer);
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      void drainRebuilds();
    }, 150);
  }

  const watcherOptions = {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 150,
      pollInterval: 30,
    },
  };
  const ssrOutput = path.join(repoRoot, 'build', 'ssr', 'HomePage.cjs');
  let lastSsrDigest = fileDigest(ssrOutput);
  const generationWatcher = chokidar.watch([
    path.join(repoRoot, 'content', 'public.sqlite'),
    path.join(repoRoot, 'scripts', 'generate-site.js'),
    path.join(repoRoot, 'scripts', 'verify-generated-site.js'),
    path.join(repoRoot, 'scripts', 'lib', '**', '*.js'),
    path.join(repoRoot, 'client', 'pages', 'homepage', 'index.html'),
    path.join(repoRoot, 'client', 'pages', 'contribute', 'katkida-bulunun.html'),
    ssrOutput,
  ], watcherOptions);
  generationWatcher.on('all', (_event, filename) => {
    if (path.resolve(filename) === ssrOutput) {
      const digest = fileDigest(ssrOutput);
      if (digest === lastSsrDigest) return;
      lastSsrDigest = digest;
    }
    schedule('site');
  });
  watchers.push(generationWatcher);

  const goWatcher = chokidar.watch([
    path.join(repoRoot, 'cmd', '**', '*.go'),
    path.join(repoRoot, 'internal', '**', '*.go'),
    path.join(repoRoot, 'go.mod'),
    path.join(repoRoot, 'go.sum'),
  ], watcherOptions);
  goWatcher.on('all', () => schedule('go'));
  watchers.push(goWatcher);

  const mediaWatcher = chokidar.watch([
    path.join(options.mediaRoot, 'images', 'sayi*', '**', '*'),
    path.join(options.mediaRoot, 'audio', 'sayi*', '**', '*'),
  ], watcherOptions);
  mediaWatcher.on('all', () => schedule('media'));
  watchers.push(mediaWatcher);

  const carouselSheetWatcher = chokidar.watch(
    carouselSheetWatchPaths,
    watcherOptions,
  );
  carouselSheetWatcher.on('all', () => schedule('carousel'));
  watchers.push(carouselSheetWatcher);

  frontendBuildChild = spawn(process.execPath, [
    frontendBuilder,
    '--development',
    '--watch',
  ], {
    cwd: repoRoot,
    env: childEnvironment,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  frontendBuildChild.once('error', (error) => {
    process.stderr.write(`[galata-dev] Vite watcher failed: ${error.message}\n`);
    void shutdown(1);
  });
  frontendBuildChild.once('exit', (code, signal) => {
    if (!stopping && !intentionallyStopped.has(frontendBuildChild)) {
      process.stderr.write(
        `[galata-dev] Vite watcher stopped unexpectedly (${signal || code})\n`,
      );
      void shutdown(1);
    }
  });

  await waitForFrontendReady(frontendBuildChild);
  if (stopping) return;
  log(`local contributions persist in ${options.contributionsDir}`);
  log(`ready at ${developmentUrl(options.port)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (shutdownRequested) return;
    process.stderr.write(`[galata-dev] ${error.message || error}\n`);
    process.exitCode = 1;
  });
}
