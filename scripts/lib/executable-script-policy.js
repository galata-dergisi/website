// Copyright 2026 Mehmet Baker
//
// Defines the exact tracked script URLs that generated HTML may execute.

const { decodeHtmlEntities } = require('./seo-utils.js');
const { shellAssetEntries } = require('./shell-assets.js');
const { DEVELOPMENT_RUNTIME_PATH } = require('./development-rendering.js');

function executableScriptSources({
  development,
  expectedBaseUrl,
  shellAssetManifest,
}) {
  const expectedOrigin = new URL(expectedBaseUrl).origin;
  const allowedSources = new Set(shellAssetEntries
    .map(([logicalPath]) => logicalPath)
    .filter((logicalPath) => logicalPath.endsWith('.js'))
    .map((logicalPath) => (
      development ? logicalPath : shellAssetManifest.assets[logicalPath].url
    )));
  if (development) allowedSources.add(DEVELOPMENT_RUNTIME_PATH);

  function assertAllowed(value, route) {
    const decoded = decodeHtmlEntities(String(value)).trim();
    if (!decoded) {
      throw new Error(`${route} has an invalid executable script source: ${value}`);
    }

    let resolved;
    try {
      resolved = new URL(decoded, `${expectedBaseUrl.replace(/\/+$/, '')}/`);
    } catch (error) {
      throw new Error(`${route} has an invalid executable script source: ${value}`, {
        cause: error,
      });
    }
    if (resolved.origin !== expectedOrigin) {
      throw new Error(`${route} has an external executable script source: ${value}`);
    }

    const requestTarget = `${resolved.pathname}${resolved.search}`;
    if (!allowedSources.has(requestTarget)) {
      throw new Error(`${route} contains an unreviewed executable script source: ${value}`);
    }
  }

  return Object.freeze({ assertAllowed });
}

module.exports = {
  executableScriptSources,
};
