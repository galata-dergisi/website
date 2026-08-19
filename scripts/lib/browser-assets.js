const fs = require('fs');
const path = require('path');

const MANIFEST_RELATIVE_PATH = 'public/.vite/manifest.json';
const HOMEPAGE_ENTRY = 'client/pages/homepage/index.js';

function manifestPath(projectRoot) {
  return path.join(projectRoot, MANIFEST_RELATIVE_PATH);
}

function assertOutput(projectRoot, file, description) {
  if (!/^(?:bundle\.(?:js|css)|assets\/[A-Za-z0-9_.-]+\.(?:js|css))$/.test(file || '')) {
    throw new Error(`Invalid Vite ${description} output: ${file}`);
  }
  const relativeFile = `public/${file}`;
  if (!fs.existsSync(path.join(projectRoot, relativeFile))) {
    throw new Error(`Missing Vite ${description} output: ${relativeFile}`);
  }
  return {
    file: relativeFile,
    url: `/${file}`,
  };
}

function readBrowserAssetManifest(projectRoot) {
  const filename = manifestPath(projectRoot);
  if (!fs.existsSync(filename)) {
    throw new Error('Vite browser manifest is missing. Run the client build again.');
  }
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const homepageEntry = manifest[HOMEPAGE_ENTRY];
  const entries = Object.entries(manifest).filter(([key]) => !key.startsWith('__'));
  if (
    !homepageEntry?.isEntry
    || entries.length !== 1
    || (homepageEntry.dynamicImports || []).length !== 0
  ) {
    throw new Error('Vite browser manifest must contain one unsplit homepage entry.');
  }
  const homepage = [
    assertOutput(projectRoot, homepageEntry.file, 'homepage JavaScript'),
    ...(homepageEntry.css || []).map((file) => assertOutput(
      projectRoot,
      file,
      'homepage stylesheet',
    )),
  ];
  return {
    homepage,
    raw: manifest,
  };
}

module.exports = {
  HOMEPAGE_ENTRY,
  MANIFEST_RELATIVE_PATH,
  manifestPath,
  readBrowserAssetManifest,
};
