import crypto from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const require = createRequire(import.meta.url);
const { createShellAssetManifest } = require('./lib/shell-assets.js');
const serviceWorkerTemplate = path.join(projectRoot, 'client', 'service-worker.js');
const serviceWorkerOutput = path.join(projectRoot, 'public', 'service-worker.js');

const VERSION_MARKER = '__GALATA_ASSET_VERSION__';
const PRECACHE_MARKER = '/* __GALATA_PRECACHE_URLS__ */ []';
const READER_MARKER = '/* __GALATA_READER_WARM_URLS__ */ []';
const CONTRIBUTION_MARKER = '/* __GALATA_CONTRIBUTION_URLS__ */ []';

function replaceExactlyOnce(source, marker, replacement) {
  const first = source.indexOf(marker);
  const last = source.lastIndexOf(marker);

  if (first === -1 || first !== last) {
    throw new Error(`Expected exactly one service-worker marker: ${marker}`);
  }

  return `${source.slice(0, first)}${replacement}${source.slice(first + marker.length)}`;
}

export function finalizeServiceWorker({ allowMissing = false } = {}) {
  const template = fs.readFileSync(serviceWorkerTemplate, 'utf8');
  let assetManifest;
  try {
    assetManifest = createShellAssetManifest(projectRoot);
  } catch (error) {
    if (allowMissing && /Missing|missing/.test(error.message)) return null;
    throw error;
  }

  const releaseHash = crypto.createHash('sha256');
  releaseHash.update('galata-service-worker-v2\0');
  releaseHash.update(template);
  releaseHash.update('\0');
  releaseHash.update(JSON.stringify(assetManifest));
  const release = releaseHash.digest('hex').slice(0, 16);

  let generated = replaceExactlyOnce(template, VERSION_MARKER, release);
  generated = replaceExactlyOnce(
    generated,
    PRECACHE_MARKER,
    JSON.stringify(assetManifest.groups.homepage, null, 2),
  );
  generated = replaceExactlyOnce(
    generated,
    READER_MARKER,
    JSON.stringify(assetManifest.groups.reader, null, 2),
  );
  generated = replaceExactlyOnce(
    generated,
    CONTRIBUTION_MARKER,
    JSON.stringify(assetManifest.groups.contribution, null, 2),
  );

  fs.mkdirSync(path.dirname(serviceWorkerOutput), { recursive: true });
  const previous = fs.existsSync(serviceWorkerOutput)
    ? fs.readFileSync(serviceWorkerOutput, 'utf8')
    : null;

  if (previous !== generated) fs.writeFileSync(serviceWorkerOutput, generated);

  return {
    release,
    output: serviceWorkerOutput,
    precacheCount: assetManifest.groups.homepage.length,
    precacheURLs: assetManifest.groups.homepage,
    readerWarmURLs: assetManifest.groups.reader,
    contributionURLs: assetManifest.groups.contribution,
    assetManifest,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = finalizeServiceWorker();
  process.stdout.write(
    `Finalized service worker ${result.release} (${result.precacheCount} homepage assets).\n`,
  );
}
