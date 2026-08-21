#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';
import livereload from 'livereload';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { finalizeServiceWorker } from './finalize-service-worker.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const development = process.argv.includes('--development') || process.argv.includes('--watch');
const watch = process.argv.includes('--watch');
const frontendReadyMessage = 'galata-frontend-ready';
const svelteConfig = path.join(projectRoot, 'svelte.config.mjs');

const liveReloadBanner = [
  '(function(d,s){if(!d||d.getElementById(\'livereloadscript\'))return;',
  's=d.createElement(\'script\');s.async=1;',
  's.src=\'//127.0.0.1:35729/livereload.js?snipver=1\';',
  's.id=\'livereloadscript\';d.head.appendChild(s)})(self.document);',
].join('');

const copyTargets = [
  ['client/images', 'public/images'],
  ['client/fonts', 'public/fonts'],
  ['client/pages/homepage/index.html', 'public/index.html'],
  ['client/pages/homepage/global.css', 'public/global.css'],
  ['client/service-worker.js', 'public/service-worker.js'],
];

function copyAssets() {
  for (const [source, destination] of copyTargets) {
    const absoluteSource = path.join(projectRoot, source);
    const absoluteDestination = path.join(projectRoot, destination);
    fs.mkdirSync(path.dirname(absoluteDestination), { recursive: true });
    if (fs.statSync(absoluteSource).isDirectory()) {
      fs.cpSync(absoluteSource, absoluteDestination, { recursive: true });
    } else {
      fs.copyFileSync(absoluteSource, absoluteDestination);
    }
  }
}

function cleanGeneratedBrowserAssets() {
  fs.rmSync(
    path.join(projectRoot, 'public/katkida-bulunun'),
    { force: true, recursive: true },
  );
  fs.rmSync(path.join(projectRoot, 'public/assets'), { force: true, recursive: true });
  fs.rmSync(path.join(projectRoot, 'public/.vite'), { force: true, recursive: true });
  fs.rmSync(
    path.join(projectRoot, 'public/images/legacy-player-icons'),
    { force: true, recursive: true },
  );
  fs.rmSync(path.join(projectRoot, 'public/images/wall-bookshelf-first.png'), { force: true });
}

function removeDevelopmentSourceMaps() {
  if (development) return;
  for (const filename of [
    'public/bundle.js.map',
    'build/ssr/HomePage.cjs.map',
  ]) {
    fs.rmSync(path.join(projectRoot, filename), { force: true });
  }
}

function copiedAssetWatcher() {
  return {
    name: 'galata-copied-assets',
    buildStart() {
      const addSource = (source) => {
        this.addWatchFile(source);
        if (!fs.statSync(source).isDirectory()) return;
        for (const entry of fs.readdirSync(source)) {
          addSource(path.join(source, entry));
        }
      };
      for (const [source] of copyTargets) {
        addSource(path.join(projectRoot, source));
      }
    },
  };
}

function homepageBrowserConfig() {
  return {
    configFile: false,
    mode: development ? 'development' : 'production',
    root: projectRoot,
    publicDir: false,
    clearScreen: false,
    plugins: [
      svelte({ configFile: svelteConfig }),
      copiedAssetWatcher(),
    ],
    build: {
      emptyOutDir: false,
      minify: development ? false : 'oxc',
      outDir: path.join(projectRoot, 'public'),
      sourcemap: development,
      watch: watch ? {} : null,
      cssCodeSplit: true,
      manifest: '.vite/manifest.json',
      rolldownOptions: {
        input: {
          homepage: path.join(projectRoot, 'client/pages/homepage/index.js'),
        },
        treeshake: {
          moduleSideEffects: false,
        },
        output: {
          banner: watch ? liveReloadBanner : undefined,
          entryFileNames: 'bundle.js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames(assetInfo) {
            const name = assetInfo.name || '';
            return name === 'homepage.css'
              ? 'bundle.css'
              : 'assets/[name]-[hash][extname]';
          },
        },
      },
    },
  };
}

function ssrConfig() {
  return {
    configFile: false,
    mode: development ? 'development' : 'production',
    root: projectRoot,
    publicDir: false,
    clearScreen: false,
    plugins: [svelte({ configFile: svelteConfig, emitCss: false })],
    ssr: {
      noExternal: true,
    },
    build: {
      emptyOutDir: false,
      minify: false,
      outDir: path.join(projectRoot, 'build/ssr'),
      sourcemap: development,
      ssr: path.join(projectRoot, 'client/pages/homepage/ssr.js'),
      watch: watch ? {} : null,
      rolldownOptions: {
        output: {
          codeSplitting: false,
          entryFileNames: 'HomePage.cjs',
          format: 'cjs',
        },
      },
    },
  };
}

const configurations = [
  homepageBrowserConfig(),
  ssrConfig(),
];

function startLiveReload() {
  const server = livereload.createServer({
    noListen: true,
    port: 35729,
  });
  const httpServer = server.config.server;
  const listen = httpServer.listen.bind(httpServer);
  httpServer.listen = (port, callback) => listen(port, '127.0.0.1', callback);
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(() => {
      server.removeListener('error', onError);
      server.on('error', (error) => {
        process.stderr.write(`LiveReload failed: ${error.message}\n`);
      });
      server.watch(path.join(projectRoot, 'public'));
      process.stdout.write('LiveReload enabled on 127.0.0.1:35729\n');
      resolve(server);
    });
  });
}

async function watchBuilds() {
  cleanGeneratedBrowserAssets();
  copyAssets();
  const liveReloadServer = await startLiveReload();
  let finalizeTimer = null;
  let initialFinalization = true;
  const completedBuilds = new Set();

  function scheduleFinalization(index) {
    completedBuilds.add(index);
    if (completedBuilds.size !== configurations.length) return;
    clearTimeout(finalizeTimer);
    finalizeTimer = setTimeout(() => {
      copyAssets();
      const result = finalizeServiceWorker();
      process.stdout.write(
        `Finalized service worker ${result.release} (${result.precacheCount} shell assets).\n`,
        () => {
          if (!initialFinalization) return;
          initialFinalization = false;
          if (typeof process.send === 'function' && process.connected) {
            process.send({ type: frontendReadyMessage });
          }
        },
      );
    }, 100);
  }

  async function startWatcher(configuration, index) {
    const watcher = await build(configuration);
    await new Promise((resolve, reject) => {
      watcher.on('event', (event) => {
        if (event.code === 'BUNDLE_START') completedBuilds.delete(index);
        if (event.code === 'BUNDLE_END') {
          event.result.close();
          scheduleFinalization(index);
          resolve();
        }
        if (event.code === 'ERROR') {
          process.stderr.write(`${event.error.stack || event.error}\n`);
          reject(event.error);
        }
      });
    });
    return watcher;
  }

  return (async () => {
    const watchers = [];
    for (let index = 0; index < configurations.length; index += 1) {
      watchers.push(await startWatcher(configurations[index], index));
    }
    async function close() {
      clearTimeout(finalizeTimer);
      await Promise.all(watchers.map((watcher) => watcher.close()));
      liveReloadServer.close();
    }
    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
  })();
}

async function buildOnce() {
  removeDevelopmentSourceMaps();
  cleanGeneratedBrowserAssets();
  copyAssets();
  for (let index = 0; index < configurations.length; index += 1) {
    await build(configurations[index]);
  }
  const result = finalizeServiceWorker();
  process.stdout.write(
    `Finalized service worker ${result.release} (${result.precacheCount} shell assets).\n`,
  );
}

if (watch) {
  await watchBuilds();
} else {
  await buildOnce();
}
