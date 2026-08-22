import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '..');
const require = createRequire(import.meta.url);
const { executableScriptSources } = require('../scripts/lib/executable-script-policy.js');
const { DEVELOPMENT_RUNTIME_PATH } = require('../scripts/lib/development-rendering.js');
const { shellAssetEntries } = require('../scripts/lib/shell-assets.js');

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function rules(relativePath) {
  return new Map(read(relativePath).split('\n')
    .filter((line) => /^\d+\t/.test(line))
    .map((line) => {
      const [id, level] = line.split('\t');
      return [id, level];
    }));
}

function testShellAssetManifest() {
  return {
    assets: Object.fromEntries(shellAssetEntries.map(([logicalPath]) => [
      logicalPath,
      { url: `${logicalPath}?v=0123456789abcdef` },
    ])),
  };
}

test('generated executable scripts use only tracked release URLs', () => {
  const production = executableScriptSources({
    development: false,
    expectedBaseUrl: 'https://galatadergisi.org',
    shellAssetManifest: testShellAssetManifest(),
  });
  for (const source of [
    '/bundle.js?v=0123456789abcdef',
    '/assets/contributor-profile.js?v=0123456789abcdef',
    '/assets/legacy/sayi45-page34.js?v=0123456789abcdef',
  ]) {
    assert.doesNotThrow(() => production.assertAllowed(source, '/reviewed'));
  }
  assert.throws(
    () => production.assertAllowed('/images/sayi45/payload.js', '/unreviewed'),
    /unreviewed executable script source/,
  );
  assert.throws(
    () => production.assertAllowed('/bundle.js?v=ffffffffffffffff', '/stale'),
    /unreviewed executable script source/,
  );
  assert.throws(
    () => production.assertAllowed('https://example.com/payload.js', '/external'),
    /external executable script source/,
  );
  assert.throws(
    () => production.assertAllowed(DEVELOPMENT_RUNTIME_PATH, '/production'),
    /unreviewed executable script source/,
  );

  const development = executableScriptSources({
    development: true,
    expectedBaseUrl: 'http://127.0.0.1:3000',
    shellAssetManifest: testShellAssetManifest(),
  });
  assert.doesNotThrow(
    () => development.assertAllowed(DEVELOPMENT_RUNTIME_PATH, '/development'),
  );
  assert.doesNotThrow(() => development.assertAllowed('/bundle.js', '/development'));
});

test('primary ZAP commands traverse isolated production nginx', () => {
  const packageJson = JSON.parse(read('package.json'));
  const compose = read('ops/zap/compose.yaml');
  const runner = read('scripts/zap-scan.sh');
  const nginxDockerfile = read('ops/zap/Dockerfile.nginx');

  assert.equal(packageJson.scripts['security:zap'], 'sh scripts/zap-scan.sh');
  assert.equal(
    packageJson.scripts['security:zap:active'],
    'sh scripts/zap-scan.sh active',
  );
  assert.equal(
    packageJson.scripts['security:zap:origin'],
    'sh scripts/zap-scan.sh baseline origin',
  );
  assert.equal(
    packageJson.scripts['security:zap:active:origin'],
    'sh scripts/zap-scan.sh active origin',
  );
  assert.match(compose, /aliases:\s*\n\s*- galatadergisi\.org/);
  assert.match(compose, /network_mode: service:app/);
  assert.doesNotMatch(compose, /^\s*ports:/m);
  assert.match(runner, /ZAP_TARGET=http:\/\/galatadergisi\.org:8080/);
  assert.match(runner, /ZAP_TARGET=http:\/\/app:3000/);
  assert.match(runner, /ZAP_APP_LISTEN_ADDR=127\.0\.0\.1:3000/);
  assert.match(runner, /ZAP_APP_LISTEN_ADDR=0\.0\.0\.0:3000/);
  assert.match(runner, /ZAP_REPORT_STEM=zap-report/);
  assert.match(runner, /ZAP_REPORT_STEM=zap-active-report/);
  assert.match(runner, /ZAP_REPORT_STEM=zap-origin-report/);
  assert.match(runner, /ZAP_REPORT_STEM=zap-origin-active-report/);
  assert.match(nginxDockerfile, /COPY ops\/nginx\/galatadergisi\.org\.conf/);
  assert.match(nginxDockerfile, /COPY ops\/nginx\/dev\.galatadergisi\.org\.conf/);
  assert.match(nginxDockerfile, /COPY ops\/nginx\/galata-dev-csp\.conf/);
  assert.match(nginxDockerfile, /listen 8080/);
  assert.match(nginxDockerfile, /nginx -t/);
});

test('ZAP excludes externally deployed media from both attack phases', () => {
  const hook = read('ops/zap/media-exclusions.py');
  const baseline = read('ops/zap/run-baseline.sh');
  const active = read('ops/zap/run-active.sh');

  assert.match(hook, /images\/sayi\[0-9\]\+/);
  assert.match(hook, /magazines\/sayi\[0-9\]\+\/audio/);
  assert.match(hook, /zap\.spider\.exclude_from_scan/);
  assert.match(hook, /zap\.ascan\.exclude_from_scan/);
  assert.match(baseline, /--hook \/zap\/config\/media-exclusions\.py/);
  assert.match(active, /--hook \/zap\/config\/media-exclusions\.py/);
});

test('nginx and origin scans have separate reviewed rule policies', () => {
  const nginxBaseline = rules('ops/zap/baseline.conf');
  const nginxActive = rules('ops/zap/active.conf');
  const originBaseline = rules('ops/zap/origin-baseline.conf');
  const originActive = rules('ops/zap/origin-active.conf');

  for (const id of ['10020', '10021', '10035']) {
    assert.equal(nginxBaseline.get(id), 'FAIL');
    assert.equal(nginxActive.get(id), 'FAIL');
    assert.equal(originBaseline.get(id), 'IGNORE');
    assert.equal(originActive.get(id), 'IGNORE');
  }
  assert.equal(nginxBaseline.get('10038'), 'INFO');
  assert.equal(nginxActive.get('10038'), 'INFO');
  assert.equal(nginxBaseline.get('10055'), 'INFO');
  assert.equal(nginxActive.get('10055'), 'INFO');
});

test('deployed vhosts use centralized report-only security policies', () => {
  const security = read('ops/nginx/galata-security-headers.conf');
  const productionCsp = read('ops/nginx/galata-production-csp.conf');
  const devCsp = read('ops/nginx/galata-dev-csp.conf');
  const production = read('ops/nginx/galatadergisi.org.conf');
  const dev = read('ops/nginx/dev.galatadergisi.org.conf');

  assert.match(security, /Strict-Transport-Security "max-age=63072000" always/);
  assert.match(security, /X-Content-Type-Options "nosniff" always/);
  assert.match(security, /X-Frame-Options "SAMEORIGIN" always/);
  for (const csp of [productionCsp, devCsp]) {
    assert.match(csp, /add_header Content-Security-Policy-Report-Only/);
    assert.doesNotMatch(csp, /report-uri|report-to|Report-To/);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src-attr 'none'/);
    assert.match(csp, /style-src-attr 'unsafe-inline'/);
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /style-src-elem 'self';/);
    assert.doesNotMatch(csp, /'sha256-/);
  }
  assert.equal(
    (production.match(/include \/etc\/nginx\/snippets\/galata-security-headers\.conf/g)
      || []).length,
    3,
  );
  assert.equal(
    (production.match(/include \/etc\/nginx\/snippets\/galata-production-csp\.conf/g)
      || []).length,
    3,
  );
  assert.equal(
    (dev.match(/include \/etc\/nginx\/snippets\/galata-security-headers\.conf/g)
      || []).length,
    3,
  );
  assert.equal(
    (dev.match(/include \/etc\/nginx\/snippets\/galata-dev-csp\.conf/g)
      || []).length,
    3,
  );
});

test('deployment and preview install every nginx include before nginx validation', () => {
  const deploy = read('ops/deploy-server.sh');
  const helper = read('ops/deploy-helper.sh');
  const preview = read('ops/local-production/Dockerfile.nginx');

  for (const filename of [
    'galata-security-headers.conf',
    'galata-production-csp.conf',
    'galata-dev-csp.conf',
  ]) {
    assert.match(deploy, new RegExp(`ops/nginx/${filename.replace('.', '\\.')}`));
    assert.match(helper, new RegExp(`bundle/${filename.replace('.', '\\.')}`));
  }
  const devCspInstall = helper.indexOf(
    'galata-dev-csp.conf" /etc/nginx/snippets/galata-dev-csp.conf',
  );
  assert(devCspInstall >= 0);
  assert(helper.indexOf('nginx -t >/dev/null', devCspInstall) > devCspInstall);
  assert.match(preview, /COPY ops\/nginx\/galata-security-headers\.conf/);
  assert.match(preview, /COPY ops\/nginx\/galata-production-csp\.conf/);
  assert.match(preview, /COPY ops\/nginx\/galata-dev-csp\.conf/);
  assert.match(preview, /nginx -t/);
});

test('Docker preview enforces and browser-tests both deployed CSP variants', () => {
  const compose = read('ops/local-production/compose.yaml');
  const nginxDockerfile = read('ops/local-production/Dockerfile.nginx');
  const browserDockerfile = read('ops/local-production/Dockerfile.browser');
  const runner = read('scripts/test-production-preview.sh');
  const browserTest = read('scripts/test-csp-browser.mjs');
  const workflow = read('.github/workflows/verify.yml');

  assert.match(nginxDockerfile, /ARG GALATA_PREVIEW_CSP_VARIANT=production/);
  assert.match(nginxDockerfile, /ARG GALATA_PREVIEW_ENFORCE_CSP=0/);
  assert.match(nginxDockerfile, /production\|dev/);
  assert.match(
    nginxDockerfile,
    /s\/add_header Content-Security-Policy-Report-Only \/add_header Content-Security-Policy \//,
  );
  assert.match(nginxDockerfile, /nginx -t/);
  assert.match(
    compose,
    /GALATA_PREVIEW_CSP_VARIANT: \$\{GALATA_PREVIEW_CSP_VARIANT:-production\}/,
  );
  assert.match(
    compose,
    /GALATA_PREVIEW_ENFORCE_CSP: \$\{GALATA_PREVIEW_ENFORCE_CSP:-0\}/,
  );
  assert.match(compose, /profiles:\s*\n\s*- csp/);
  assert.match(compose, /dockerfile: ops\/local-production\/Dockerfile\.browser/);
  assert.match(compose, /network_mode: service:app/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /tmpfs:\s*\n\s*- \/tmp:size=512m/);
  assert.match(browserDockerfile, /FROM node:24\.18\.0-alpine/);
  assert.match(browserDockerfile, /apk add --no-cache chromium/);
  assert.match(browserDockerfile, /USER node/);
  assert.match(runner, /GALATA_PREVIEW_CSP_VARIANT=production/);
  assert.match(runner, /GALATA_PREVIEW_ENFORCE_CSP=0/);
  assert.match(runner, /run_enforced_csp_acceptance production/);
  assert.match(runner, /run_enforced_csp_acceptance dev/);
  assert.match(runner, /run --rm --no-deps browser/);
  assert.match(browserTest, /Audits\.issueAdded/);
  assert.match(browserTest, /Network\.loadingFailed/);
  assert.match(browserTest, /Runtime\.exceptionThrown/);
  for (const route of [
    '/dergiler/sayi45/34',
    '/katkida-bulunanlar/15-nafizcan-onder',
    '/dergiler/sayi46/58',
  ]) {
    assert.match(browserTest, new RegExp(route.replaceAll('/', '\\/')));
  }
  for (const directive of [
    'base-uri',
    'connect-src',
    'frame-src',
    'object-src',
    'script-src-attr',
    'style-src-attr',
  ]) {
    assert.match(browserTest, new RegExp(directive));
  }
  assert.match(workflow, /run: npm run test:production-preview/);
  assert.match(
    workflow,
    /GALATA_MEDIA_ROOT: \$\{\{ github\.workspace \}\}\/\.static-assets\/server-assets\/public/,
  );
});
