import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, '..');
const require = createRequire(import.meta.url);

function projectPath(relativePath) {
  return path.join(projectRoot, relativePath);
}

test('Vite preserves the browser, SSR, and copied-asset contracts', () => {
  const requiredFiles = [
    'public/assets/contributor-profile.css',
    'public/assets/contributor-profile.js',
    'public/assets/static-page.css',
    'public/assets/legacy/sayi23-page21.css',
    'public/assets/legacy/sayi45-page34.css',
    'public/assets/legacy/sayi45-page34.js',
    'public/assets/legacy/sayi46-page58.css',
    'public/bundle.js',
    'public/bundle.css',
    'public/index.html',
    'public/global.css',
    'public/service-worker.js',
    'public/.vite/manifest.json',
    'build/ssr/HomePage.cjs',
  ];
  for (const filename of requiredFiles) {
    assert.ok(fs.statSync(projectPath(filename)).isFile(), `${filename} is missing`);
  }

  const homepageOutputs = fs.readdirSync(projectPath('public'))
    .filter((filename) => /\.(?:js|css|map)$/.test(filename))
    .sort();
  assert.deepEqual(homepageOutputs, [
    'bundle.css',
    'bundle.js',
    'global.css',
    'service-worker.js',
  ]);

  const browserManifest = JSON.parse(
    fs.readFileSync(projectPath('public/.vite/manifest.json'), 'utf8'),
  );
  assert.deepEqual(Object.keys(browserManifest), ['client/pages/homepage/index.js']);
  const homepageEntry = browserManifest['client/pages/homepage/index.js'];
  assert.equal(homepageEntry.isEntry, true);
  assert.deepEqual(homepageEntry.dynamicImports || [], []);
  assert.deepEqual(homepageEntry.css, ['bundle.css']);
  const assetDirectory = projectPath('public/assets');
  const generatedAssets = fs.existsSync(assetDirectory) ? fs.readdirSync(assetDirectory) : [];
  assert.equal(generatedAssets.some((file) => /^reader-/.test(file)), false);

  const copiedFiles = [
    ['client/fonts/akaDora.woff2', 'public/fonts/akaDora.woff2'],
    ['client/pages/homepage/index.html', 'public/index.html'],
  ];
  for (const [source, output] of copiedFiles) {
    assert.deepEqual(fs.readFileSync(projectPath(output)), fs.readFileSync(projectPath(source)));
  }

  const serviceWorker = fs.readFileSync(projectPath('public/service-worker.js'), 'utf8');
  assert.doesNotMatch(serviceWorker, /__GALATA_ASSET_VERSION__|__GALATA_PRECACHE_URLS__/);
});

test('the bundled SSR adapter retains render(props) -> { html } with hydration markers', () => {
  delete require.cache[require.resolve(projectPath('build/ssr/HomePage.cjs'))];
  const adapter = require(projectPath('build/ssr/HomePage.cjs'));
  assert.deepEqual(Object.keys(adapter), ['render']);
  const result = adapter.render({ initialMagazines: [] });
  assert.deepEqual(Object.keys(result), ['html']);
  assert.match(result.html, /<!--\[/);
  assert.match(result.html, /<!--\]-->/);
});
