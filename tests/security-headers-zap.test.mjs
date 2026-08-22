import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '..');

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
    assert.equal((csp.match(/'sha256-/g) || []).length, 6);
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
  assert.match(preview, /nginx -t/);
});
