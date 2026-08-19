import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '..');
const deployScript = path.join(repositoryRoot, 'ops/deploy-server.sh');
const helperScript = path.join(repositoryRoot, 'ops/deploy-helper.sh');
const runtimeEnvironmentScript = path.join(repositoryRoot, 'ops/runtime-environment.sh');

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function writeExecutable(filename, content) {
  fs.writeFileSync(filename, content, { mode: 0o755 });
}

function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'galata-deploy-test-'));
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'commands.log');
  const key = path.join(root, 'deploy-key');
  const knownHosts = path.join(root, 'known_hosts');
  fs.mkdirSync(bin);
  fs.writeFileSync(key, 'test-key\n', { mode: 0o600 });
  fs.writeFileSync(knownHosts, 'example.invalid ssh-ed25519 AAAA\n', { mode: 0o600 });

  writeExecutable(path.join(bin, 'ssh'), `#!/bin/sh
printf 'ssh %s\n' "$*" >> "$FAKE_LOG"
case "$*" in
  *'galata-deploy-helper status'*) printf '%s\n' architecture=amd64 cache_bytes=0 ;;
  *'df -Pk'*) printf '%s\n' "$FAKE_AVAILABLE" ;;
  *'galata-deploy-helper verify'*) printf '%s\\n' "\${FAKE_VERIFY_OUTPUT:-verified}" ;;
  *'galata-deploy-helper activate'*) printf '%s\n' activated ;;
  *'galata-deploy-helper rollback'*) printf '%s\n' rolled-back ;;
esac
exit 0
`);
  writeExecutable(path.join(bin, 'rsync'), `#!/bin/sh
if [ "\${1:-}" = --info=progress2 ] && [ "\${2:-}" = --version ]; then exit 1; fi
printf 'rsync %s\n' "$*" >> "$FAKE_LOG"
exit 0
`);
  writeExecutable(path.join(bin, 'curl'), `#!/bin/sh
printf '%s' "\${FAKE_CURL_OUTPUT:-}"
exit "\${FAKE_CURL_STATUS:-0}"
`);

  return {
    root,
    log,
    environment: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_LOG: log,
      FAKE_AVAILABLE: '999999999',
      GALATA_DEPLOY_HOST: 'example.invalid',
      GALATA_DEPLOY_PORT: '22',
      GALATA_DEPLOY_SSH_KEY_PATH: key,
      GALATA_SSH_KNOWN_HOSTS_FILE: knownHosts,
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function createRelease(harness) {
  const media = path.join(harness.root, 'media');
  const release = path.join(harness.root, 'release');
  fs.mkdirSync(path.join(media, 'images', 'sayi1'), { recursive: true });
  fs.mkdirSync(path.join(media, 'audio', 'sayi1'), { recursive: true });
  fs.mkdirSync(release);
  fs.writeFileSync(path.join(media, 'images', 'sayi1', 'page.jpg'), 'image');
  fs.writeFileSync(path.join(media, 'audio', 'sayi1', 'track.mp3'), 'audio');
  childProcess.execFileSync('git', ['init', '-q'], { cwd: media });
  childProcess.execFileSync('git', ['add', '.'], { cwd: media });
  childProcess.execFileSync(
    'git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'media',
    ],
    { cwd: media },
  );
  const staticCommit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: media, encoding: 'utf8',
  }).trim();
  const inventory = [
    `${sha256('audio')}  audio/sayi1/track.mp3`,
    `${sha256('image')}  images/sayi1/page.jpg`,
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(release, 'MEDIA-SHA256SUMS'), inventory);
  fs.writeFileSync(path.join(release, 'galata-server-linux-amd64'), 'amd64', { mode: 0o755 });
  fs.writeFileSync(path.join(release, 'galata-server-linux-arm64'), 'arm64', { mode: 0o755 });
  const appCommit = 'a'.repeat(40);
  const siteRelease = 'b'.repeat(16);
  const releaseId = `${appCommit.slice(0, 12)}-${siteRelease}`;
  const manifest = [
    'format=1',
    `release_id=${releaseId}`,
    `application_commit=${appCommit}`,
    `static_assets_commit=${staticCommit}`,
    `embedded_site_release=${siteRelease}`,
    'architectures=amd64,arm64',
    `binary_amd64_sha256=${sha256('amd64')}`,
    `binary_arm64_sha256=${sha256('arm64')}`,
    `media_inventory_sha256=${sha256(inventory)}`,
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(release, 'RELEASE-MANIFEST'), manifest);
  const sums = [
    `${sha256('amd64')}  galata-server-linux-amd64`,
    `${sha256('arm64')}  galata-server-linux-arm64`,
    `${sha256(inventory)}  MEDIA-SHA256SUMS`,
    `${sha256(manifest)}  RELEASE-MANIFEST`,
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(release, 'SHA256SUMS'), sums);
  return { media, release, releaseId };
}

function invoke(harness, ...arguments_) {
  return childProcess.spawnSync('bash', [deployScript, ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: harness?.environment ?? process.env,
  });
}

test('no arguments show help without invoking an external command', () => {
  const harness = createHarness();
  try {
    const result = invoke(harness);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /deploy <dev\|production>/);
    assert.equal(fs.existsSync(harness.log), false);
  } finally { harness.cleanup(); }
});

test('interactive secret commands fail closed without a terminal', () => {
  for (const command of ['configure', 'tunnel-setup']) {
    const harness = createHarness();
    try {
      const result = invoke(harness, command);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /workstation-only and interactive/);
      assert.equal(fs.existsSync(harness.log), false);
    } finally { harness.cleanup(); }
  }
});

test('verify and rollback use only the restricted deployment connection', () => {
  const harness = createHarness();
  try {
    assert.equal(invoke(harness, 'verify', 'dev').status, 0);
    assert.equal(invoke(harness, 'rollback', 'production', '--yes').status, 0);
    const log = fs.readFileSync(harness.log, 'utf8');
    assert.match(log, /galata-deploy@example\.invalid/);
    assert.match(log, /galata-deploy-helper verify 'dev'/);
    assert.match(log, /galata-deploy-helper rollback 'production'/);
    assert.doesNotMatch(log, /ssh galata /);
  } finally { harness.cleanup(); }
});

test('public dev verification requires a Cloudflare Access login redirect', () => {
  const releaseId = `${'a'.repeat(12)}-${'b'.repeat(16)}`;
  const allowed = createHarness();
  allowed.environment.FAKE_CURL_OUTPUT = [
    'HTTP/2 302',
    'location: https://galata.cloudflareaccess.com/cdn-cgi/access/login/dev.galatadergisi.org',
    '',
    '',
  ].join('\r\n');
  allowed.environment.FAKE_VERIFY_OUTPUT = `verified release=${releaseId}`;
  try {
    const result = invoke(allowed, 'verify', 'dev', '--public');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dev Cloudflare Access gate verified/);
  } finally { allowed.cleanup(); }

  const exposed = createHarness();
  exposed.environment.FAKE_CURL_OUTPUT = 'HTTP/2 200\r\n\r\n';
  exposed.environment.FAKE_VERIFY_OUTPUT = `verified release=${releaseId}`;
  try {
    const result = invoke(exposed, 'verify', 'dev', '--public');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not gated by Cloudflare Access/);
  } finally { exposed.cleanup(); }
});

test('a valid deployment uploads only the selected binary and immutable inventory', () => {
  const harness = createHarness();
  try {
    const fixture = createRelease(harness);
    const result = invoke(
      harness, 'deploy', 'dev', '--release-dir', fixture.release,
      '--media-root', fixture.media, '--yes',
    );
    assert.equal(result.status, 0, result.stderr);
    const log = fs.readFileSync(harness.log, 'utf8');
    assert.match(log, /incoming\/aaaaaaaaaaaa-bbbbbbbbbbbbbbbb-dev/);
    assert.match(log, /--link-dest=\/var\/lib\/galata-deploy\/media-cache/);
    assert.match(log, /--progress --human-readable --stats/);
    assert.match(log, /\/media\/images .*\/media\/audio /);
    assert.doesNotMatch(log, /--include|--exclude/);
    assert.match(result.stdout, /Uploading application bundle/);
    assert.match(result.stdout, /Uploading media \(2 files,/);
    assert.match(log, /galata-deploy-helper activate 'dev' 'aaaaaaaaaaaa-bbbbbbbbbbbbbbbb'/);
    assert.doesNotMatch(log, /galata-server-linux-arm64/);
  } finally { harness.cleanup(); }
});

test('altered binaries and dirty media abort before upload or activation', () => {
  for (const mutation of ['binary', 'media']) {
    const harness = createHarness();
    try {
      const fixture = createRelease(harness);
      if (mutation === 'binary') {
        fs.appendFileSync(path.join(fixture.release, 'galata-server-linux-amd64'), 'tampered');
      } else {
        fs.appendFileSync(path.join(fixture.media, 'images', 'sayi1', 'page.jpg'), 'tampered');
      }
      const result = invoke(
        harness, 'deploy', 'production', '--release-dir', fixture.release,
        '--media-root', fixture.media, '--yes',
      );
      assert.notEqual(result.status, 0);
      const log = fs.existsSync(harness.log) ? fs.readFileSync(harness.log, 'utf8') : '';
      assert.doesNotMatch(log, /rsync|activate/);
    } finally { harness.cleanup(); }
  }
});

test('insufficient remote disk aborts before upload and activation', () => {
  const harness = createHarness();
  try {
    const fixture = createRelease(harness);
    harness.environment.FAKE_AVAILABLE = '1';
    const result = invoke(
      harness, 'deploy', 'dev', '--release-dir', fixture.release,
      '--media-root', fixture.media, '--yes',
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /insufficient remote disk/);
    assert.doesNotMatch(fs.readFileSync(harness.log, 'utf8'), /rsync|activate/);
  } finally { harness.cleanup(); }
});

test('manifest traversal, symlink media, and unsafe release ids are rejected', () => {
  for (const mutation of ['traversal', 'symlink', 'release-id']) {
    const harness = createHarness();
    try {
      const fixture = createRelease(harness);
      if (mutation === 'traversal') {
        const inventoryPath = path.join(fixture.release, 'MEDIA-SHA256SUMS');
        const inventory = `${sha256('image')}  images/../secret\n`;
        fs.writeFileSync(inventoryPath, inventory);
        const manifestPath = path.join(fixture.release, 'RELEASE-MANIFEST');
        fs.writeFileSync(
          manifestPath,
          fs.readFileSync(manifestPath, 'utf8').replace(
            /^media_inventory_sha256=.*$/m, `media_inventory_sha256=${sha256(inventory)}`,
          ),
        );
      } else if (mutation === 'symlink') {
        fs.symlinkSync('/etc/passwd', path.join(fixture.media, 'images', 'sayi1', 'unsafe'));
      } else {
        const manifestPath = path.join(fixture.release, 'RELEASE-MANIFEST');
        fs.writeFileSync(
          manifestPath,
          fs.readFileSync(manifestPath, 'utf8').replace(/^release_id=.*$/m, 'release_id=../../unsafe'),
        );
      }
      const result = invoke(
        harness, 'deploy', 'dev', '--release-dir', fixture.release,
        '--media-root', fixture.media, '--yes',
      );
      assert.notEqual(result.status, 0);
    } finally { harness.cleanup(); }
  }
});

test('tracked helper encodes slot isolation, candidate checks, rollback, and sudo boundaries', () => {
  const helper = fs.readFileSync(helperScript, 'utf8');
  const deploy = fs.readFileSync(deployScript, 'utf8');
  const runtimeEnvironment = fs.readFileSync(runtimeEnvironmentScript, 'utf8');
  const deployTestDockerfile = fs.readFileSync(
    path.join(repositoryRoot, 'ops/deploy-test/Dockerfile'), 'utf8',
  );
  const tunnel = fs.readFileSync(
    path.join(repositoryRoot, 'ops/tunnel-remote.sh'), 'utf8',
  );
  const tunnelUnit = fs.readFileSync(
    path.join(repositoryRoot, 'ops/systemd/cloudflared.service'), 'utf8',
  );
  assert.match(helper, /CURRENT_LINK=\/opt\/galata\/current-dev/);
  assert.match(helper, /CURRENT_LINK=\/opt\/galata\/current\n/);
  assert.match(helper, /flock -n 9/);
  assert.match(helper, /systemd-run --quiet/);
  assert.match(
    helper,
    /\/usr\/bin\/env "LISTEN_ADDR=127\.0\.0\.1:\$CANDIDATE_PORT" "\$binary"/,
  );
  assert.doesNotMatch(helper, /--setenv="LISTEN_ADDR=/);
  assert.match(helper, /activation failed; previous code and media were restored/);
  assert.match(helper, /deployment identity cannot configure the host/);
  assert.match(helper, /test ! -r \/etc\/galata\/production\.env/);
  assert.match(helper, /test ! -r \/etc\/cloudflared\/tunnel-token/);
  assert.match(helper, /chown root:galata-deploy \/home\/galata-deploy\/\.ssh\/authorized_keys/);
  assert.match(helper, /chmod 0640 \/home\/galata-deploy\/\.ssh\/authorized_keys/);
  assert.match(helper, /test -r \/home\/galata-deploy\/\.ssh\/authorized_keys/);
  assert.match(helper, /test ! -w \/home\/galata-deploy\/\.ssh\/authorized_keys/);
  assert.match(helper, /--link-dest=/);
  assert.match(helper, /find "\$media_source" -type d -exec chmod 0555 \{\} \+/);
  assert.match(helper, /find "\$media_source" -type f -exec chmod 0444 \{\} \+/);
  assert.match(helper, /validate_published_media_permissions "\$active_media"/);
  assert.match(deploy, /ControlMaster=auto/);
  assert.match(deploy, /\. "\$SCRIPT_DIR\/runtime-environment\.sh"/);
  assert.match(deploy, /write_runtime_environment production "\$secret"/);
  assert.match(deploy, /write_runtime_environment dev "\$secret"/);
  assert.match(runtimeEnvironment, /LISTEN_ADDR=127\.0\.0\.1:3000/);
  assert.match(runtimeEnvironment, /LISTEN_ADDR=127\.0\.0\.1:3001/);
  assert.match(
    deployTestDockerfile,
    /COPY ops\/runtime-environment\.sh \/usr\/local\/libexec\/galata-runtime-environment\.sh/,
  );
  assert.match(deploy, /start_admin_control/);
  assert.match(deploy, /ssh-keyscan -t rsa,ecdsa,ed25519/);
  assert.match(deploy, /\$2 == "ssh-rsa"/);
  assert.match(deploy, /host-key verification produced an empty key set/);
  assert.match(deploy, /scanned host keys do not match the trusted administrator connection/);
  assert.match(deploy, /printf '%s\\n' "\$token" \| admin_ssh/);
  assert.doesNotMatch(deploy, /valid_tunnel_token|token =~/);
  assert.doesNotMatch(deploy, /--token[ =]"?\$token|dns_cloudflare_api_token/);
  assert.doesNotMatch(deploy, /set -x/);
  assert.match(tunnel, /root:root 600/);
  assert.match(tunnel, /cloudflared_tunnel_ha_connections/);
  assert.match(tunnel, /restore_previous/);
  assert.match(tunnel, /previous state restored/);
  assert.match(tunnelUnit, /DynamicUser=yes/);
  assert.match(tunnelUnit, /LoadCredential=tunnel-token:\/etc\/cloudflared\/tunnel-token/);
  assert.match(tunnelUnit, /--metrics 127\.0\.0\.1:20241/);
  assert.match(tunnelUnit, /--token-file %d\/tunnel-token/);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'ops/certbot-remote.sh')), false);
});

test('deployment builds and tests its own artifact while preserving provenance', () => {
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, '.github/workflows/deploy.yml'), 'utf8',
  );
  const verificationWorkflow = fs.readFileSync(
    path.join(repositoryRoot, '.github/workflows/verify.yml'), 'utf8',
  );
  assert.match(workflow, /test "\$GITHUB_REF" = refs\/heads\/main/);
  assert.match(workflow, /select\(\.head_sha ==/);
  assert.match(workflow, /Build Linux releases/);
  assert.match(workflow, /Smoke-test deployable Linux release/);
  assert.match(workflow, /Upload tested deployment artifact/);
  assert.match(workflow, /Download tested deployment artifact/);
  assert.match(workflow, /needs: build/);
  assert.match(workflow, /ref: \$\{\{ steps\.provenance\.outputs\.static_commit \}\}/);
  assert.match(workflow, /environment: \$\{\{ inputs\.target \}\}/);
  assert.match(workflow, /group: galata-vps-deployment/);
  assert.doesNotMatch(
    workflow,
    /secrets\.(?:TURNSTILE|CLOUDFLARE|BASIC_AUTH)/,
  );
  assert.match(verificationWorkflow, /name: Verify site and server/);
  assert.match(verificationWorkflow, /token: \$\{\{ secrets\.STATIC_ASSETS_TOKEN \}\}/);
  assert.match(verificationWorkflow, /persist-credentials: false/);
  assert.doesNotMatch(verificationWorkflow, /build-release\.sh/);
  assert.doesNotMatch(verificationWorkflow, /actions\/upload-artifact/);
  assert.doesNotMatch(verificationWorkflow, /release\/RELEASE-MANIFEST/);
});

test('nginx keeps tunnel-only slots, Access boundary, limits, and media roots independent', () => {
  const shared = fs.readFileSync(
    path.join(repositoryRoot, 'ops/nginx/galata-shared.conf'), 'utf8',
  );
  const production = fs.readFileSync(
    path.join(repositoryRoot, 'ops/nginx/galatadergisi.org.conf'), 'utf8',
  );
  const dev = fs.readFileSync(
    path.join(repositoryRoot, 'ops/nginx/dev.galatadergisi.org.conf'), 'utf8',
  );
  assert.match(shared, /server 127\.0\.0\.1:3000/);
  assert.match(shared, /server 127\.0\.0\.1:3001/);
  assert.match(shared, /zone=galata_contribution_rate/);
  assert.match(shared, /zone=galata_dev_contribution_rate/);
  assert.match(shared, /map \$http_cf_connecting_ip \$galata_client_address/);
  assert.doesNotMatch(shared, /galata_from_cloudflare|173\.245\.48\.0\/20/);
  assert.match(production, /listen 127\.0\.0\.1:8080;/);
  assert.match(dev, /listen 127\.0\.0\.1:8080;/);
  assert.doesNotMatch(`${production}\n${dev}`, /ssl_certificate|letsencrypt|listen 443/);
  assert.doesNotMatch(`${shared}\n${dev}`, /\bauth_basic\b/);
  assert.match(dev, /noindex, nofollow, noarchive/);
  assert.match(dev, /location = \/robots\.txt[\s\S]*Disallow: \//);
  assert.match(production, /proxy_set_header X-Forwarded-Proto https/);
  assert.match(dev, /proxy_set_header X-Forwarded-Proto https/);
  assert.match(production, /location = \/healthz[\s\S]*no-store/);
  assert.match(dev, /location = \/healthz[\s\S]*no-store/);
  assert.doesNotMatch(`${shared}\n${production}\n${dev}`, /listen\s+(80|443|3000|3001)\b/);
  const helper = fs.readFileSync(helperScript, 'utf8');
  assert.match(helper, /--header "Host: \$HOSTNAME" "http:\/\/127\.0\.0\.1:8080\/healthz"/);
});
