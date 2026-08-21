#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const defaultPolicyFile = path.join(projectRoot, 'ops', 'cloudflare', 'cache-policy.json');
const defaultSiteManifestFile = path.join(projectRoot, 'internal', 'site', 'dist', 'manifest.json');
const defaultOutputFile = path.join(projectRoot, 'release', 'CACHE-PURGE-MANIFEST');
const safeStablePath = /^\/[A-Za-z0-9._~%/-]*$/;
const strongEtag = /^"([0-9a-f]{64})"$/;

function readJSON(filename, label) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read ${label} ${filename}: ${error.message}`, { cause: error });
  }
}

export function createCachePurgeManifest({
  policyFile = defaultPolicyFile,
  siteManifestFile = defaultSiteManifestFile,
} = {}) {
  const policy = readJSON(policyFile, 'cache policy');
  const siteManifest = readJSON(siteManifestFile, 'generated site manifest');

  if (policy.version !== 1 || !Array.isArray(policy.stableCachedPaths)) {
    throw new Error('Cache policy must have version 1 and a stableCachedPaths array.');
  }
  const paths = policy.stableCachedPaths.slice().sort();
  if (new Set(paths).size !== paths.length) {
    throw new Error('Cache policy paths must be unique.');
  }

  const entries = paths.map((stablePath) => {
    if (!safeStablePath.test(stablePath) || stablePath.includes('//')
        || stablePath.includes('/./') || stablePath.includes('/../')) {
      throw new Error(`Unsafe stable cache path: ${stablePath}`);
    }
    const route = siteManifest.routes?.[stablePath];
    if (!route) throw new Error(`Stable cache path is absent from the generated site: ${stablePath}`);
    const etagMatch = strongEtag.exec(route.etag || '');
    if (!etagMatch) throw new Error(`Stable cache path lacks a strong SHA-256 ETag: ${stablePath}`);
    return { path: stablePath, contentHash: etagMatch[1] };
  });

  return `${[
    'format=1',
    ...entries.map(({ contentHash, path: stablePath }) => `${contentHash}  ${stablePath}`),
  ].join('\n')}\n`;
}

export function writeCachePurgeManifest({ outputFile = defaultOutputFile, ...options } = {}) {
  const manifest = createCachePurgeManifest(options);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, manifest);
  return { manifest, outputFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputFile = process.argv[2] ? path.resolve(process.argv[2]) : defaultOutputFile;
  const { manifest } = writeCachePurgeManifest({ outputFile });
  const entryCount = manifest.trimEnd().split('\n').length - 1;
  process.stdout.write(`Cache purge manifest written to ${outputFile} (${entryCount} stable URLs).\n`);
}
