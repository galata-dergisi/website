import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '..');
const setupScript = path.join(repositoryRoot, 'ops/setup-server.sh');
const productionNginxConfig = path.join(
  repositoryRoot,
  'ops/nginx/galatadergisi.org.conf',
);
const developmentNginxConfig = path.join(
  repositoryRoot,
  'ops/nginx/dev.galatadergisi.org.conf',
);
const administrator = 'opsadmin';

function writeExecutable(filename, content) {
  fs.writeFileSync(filename, content, { mode: 0o755 });
}

function createHarness({ scenario = 'success', initialState = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'galata-server-setup-test-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(root, 'ssh.log');
  const state = path.join(root, 'state');
  fs.writeFileSync(state, initialState);

  writeExecutable(path.join(bin, 'ssh'), `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_SSH_LOG"
arguments=$*

case "$arguments" in
  '-G galata')
    printf '%s\n' 'host galata' 'hostname 203.0.113.10' 'user root' 'port 22'
    exit 0
    ;;
esac

case "$arguments" in
  *'_remote-preflight'*)
    case "$FAKE_SCENARIO" in
      wrong-os) printf '%s\n' 'expected Ubuntu 26.04' >&2; exit 1 ;;
      unattached-pro) printf '%s\n' 'Ubuntu Pro is not attached' >&2; exit 1 ;;
      pending-reboot) printf '%s\n' 'a reboot is pending' >&2; exit 1 ;;
    esac
    printf '%s\n' 'Remote preflight passed.'
    exit 0
    ;;
  *'_remote-bootstrap-admin'*)
    printf '%s\n' admin > "$FAKE_SSH_STATE"
    exit 0
    ;;
  *'_remote-apply'*)
    case "$FAKE_SCENARIO" in
      ufw-conflict) printf '%s\n' 'UFW contains unmanaged rules' >&2; exit 1 ;;
      nginx-conflict) printf '%s\n' 'unexpected nginx site' >&2; exit 1 ;;
    esac
    printf '%s\n' admin hardened > "$FAKE_SSH_STATE"
    exit 0
    ;;
  *'_remote-verify'*)
    grep -q hardened "$FAKE_SSH_STATE" || exit 1
    printf '%s\n' 'Remote verification passed.'
    exit 0
    ;;
esac

case "$arguments" in
  *'-l ${administrator}'*'sudo -n true'*)
    [ "$FAKE_SCENARIO" != admin-validation-fails ] || exit 1
    grep -q admin "$FAKE_SSH_STATE"
    exit
    ;;
  *'-l ${administrator}'*'printf'*'SSH_CONNECTION'*)
    grep -q admin "$FAKE_SSH_STATE" || exit 1
    printf '%s\n' '198.51.100.20 54321 203.0.113.10 22'
    exit 0
    ;;
  *'test "$(id -u)" -eq 0'*)
    grep -q hardened "$FAKE_SSH_STATE" && exit 1
    exit 0
    ;;
  *'-l root'*' true')
    grep -q hardened "$FAKE_SSH_STATE" && exit 1
    exit 0
    ;;
esac

exit 65
`);

  return {
    log,
    root,
    state,
    environment: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_SCENARIO: scenario,
      FAKE_SSH_LOG: log,
      FAKE_SSH_STATE: state,
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function invoke(harness, ...scriptArguments) {
  return childProcess.spawnSync('sh', [setupScript, ...scriptArguments], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: harness.environment,
    input: `${administrator}\n`,
  });
}

function readLog(harness) {
  return fs.existsSync(harness.log) ? fs.readFileSync(harness.log, 'utf8') : '';
}

function shellFunction(source, name) {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert(match, `${name} function is missing`);
  return match[0];
}

test('help is side-effect free and documents only public commands', () => {
  const result = childProcess.spawnSync('sh', [setupScript, '--help'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /apply \[--yes\]/);
  assert.match(result.stdout, /verify/);
  assert.doesNotMatch(result.stdout, /_remote-/);
});

test('internal remote modes reject direct local invocation', () => {
  const result = childProcess.spawnSync('sh', [setupScript, '_remote-preflight'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only be invoked through the local orchestrator/);
});

test('an already-enabled Pro service is not enabled again', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'galata-pro-service-test-'));
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'pro.log');
  fs.mkdirSync(bin);
  writeExecutable(path.join(bin, 'pro'), `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_PRO_LOG"
case "$*" in
  'api u.pro.status.enabled_services.v1')
    printf '%s\n' '{"data":{"attributes":{"enabled_services":[{"name":"esm-infra"}]}}}'
    ;;
  *) exit 91 ;;
esac
`);

  try {
    const source = fs.readFileSync(setupScript, 'utf8');
    const helperSource = [
      'set -eu',
      shellFunction(source, 'die'),
      shellFunction(source, 'pro_service_enabled'),
      shellFunction(source, 'enable_pro_service'),
      'enable_pro_service esm-infra "Ubuntu Pro ESM Infra"',
    ].join('\n');
    const result = childProcess.spawnSync('sh', ['-c', helperSource], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_PRO_LOG: log,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(log, 'utf8'),
      'api u.pro.status.enabled_services.v1\n',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nginx token suppression is scoped to each application server', () => {
  for (const config of [productionNginxConfig, developmentNginxConfig]) {
    const source = fs.readFileSync(config, 'utf8');
    assert.match(source, /^server \{\n {2}server_tokens off;/);
  }
});

test('server setup installs and verifies the logrotate timer', () => {
  const source = fs.readFileSync(setupScript, 'utf8');
  assert.match(source, /nginx logrotate fail2ban/);
  assert.match(source, /systemctl enable --now logrotate\.timer/);
  assert.match(source, /assert_service_active logrotate\.timer/);
  assert.match(source, /assert_service_enabled logrotate\.timer/);
});

test('UFW defaults are verified from policy configuration, not status wording', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'galata-ufw-policy-test-'));
  const defaults = path.join(root, 'ufw');
  fs.writeFileSync(
    defaults,
    [
      'DEFAULT_INPUT_POLICY="DROP"',
      'DEFAULT_OUTPUT_POLICY="ACCEPT"',
      'DEFAULT_FORWARD_POLICY="DROP"',
      '',
    ].join('\n'),
  );

  try {
    const source = fs.readFileSync(setupScript, 'utf8');
    assert.doesNotMatch(source, /Default: deny.*deny.*routed/);
    const helperSource = [
      'set -eu',
      'PROGRAM=ufw-policy-test',
      shellFunction(source, 'die'),
      shellFunction(source, 'assert_ufw_default_policies'),
      'assert_ufw_default_policies "$1"',
    ].join('\n');
    const result = childProcess.spawnSync('sh', ['-c', helperSource, 'sh', defaults], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('firewall migration removes the legacy SSH limiter after adding ALLOW', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'galata-ufw-migration-test-'));
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'ufw.log');
  fs.mkdirSync(bin);
  writeExecutable(path.join(bin, 'ufw'), `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_UFW_LOG"
if [ "$*" = 'status numbered' ]; then
  printf '%s\n' \
    '[ 1] 22/tcp LIMIT IN Anywhere # galata-ssh' \
    '[ 2] 22/tcp ALLOW IN Anywhere # galata-ssh' \
    '[ 3] 443/tcp ALLOW IN Anywhere # galata-cloudflare-https'
fi
`);

  try {
    const source = fs.readFileSync(setupScript, 'utf8');
    const helperSource = [
      'set -eu',
      shellFunction(source, 'delete_ufw_rules_by_marker'),
      'enable_ufw_ipv6() { :; }',
      shellFunction(source, 'configure_firewall'),
      'configure_firewall 22',
    ].join('\n');
    const result = childProcess.spawnSync('sh', ['-c', helperSource], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_UFW_LOG: log,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const commands = fs.readFileSync(log, 'utf8');
    assert(
      commands.indexOf('allow 22/tcp comment galata-ssh')
        < commands.indexOf('--force delete 1'),
    );
    assert.match(commands, /^--force delete 1$/m);
    assert.match(commands, /^--force delete 3$/m);
    assert.doesNotMatch(commands, /^--force delete 2$/m);
    assert.doesNotMatch(commands, /^limit /m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unsafe administrator username aborts before network or SSH activity', () => {
  const harness = createHarness();
  try {
    const result = childProcess.spawnSync('sh', [setupScript, 'apply', '--yes'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: harness.environment,
      input: 'Bad User; touch owned\n',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /administrator username must match/);
    assert.equal(readLog(harness), '');
  } finally {
    harness.cleanup();
  }
});

for (const reservedName of ['root', 'galata']) {
  test(`reserved administrator username ${reservedName} is rejected`, () => {
    const harness = createHarness();
    try {
      const result = childProcess.spawnSync('sh', [setupScript, 'verify'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: harness.environment,
        input: `${reservedName}\n`,
      });
      assert.notEqual(result.status, 0);
      assert.equal(readLog(harness), '');
    } finally {
      harness.cleanup();
    }
  });
}

for (const [scenario, message] of [
  ['wrong-os', /expected Ubuntu 26\.04/],
  ['unattached-pro', /Ubuntu Pro is not attached/],
  ['pending-reboot', /reboot is pending/],
]) {
  test(`${scenario} preflight aborts before administrator or host mutation`, () => {
    const harness = createHarness({ scenario });
    try {
      const result = invoke(harness, 'apply', '--yes');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
      const log = readLog(harness);
      assert.doesNotMatch(log, /_remote-bootstrap-admin/);
      assert.doesNotMatch(log, /_remote-apply/);
    } finally {
      harness.cleanup();
    }
  });
}

test('failed fresh administrator validation leaves remote apply untouched', () => {
  const harness = createHarness({ scenario: 'admin-validation-fails' });
  try {
    const result = invoke(harness, 'apply', '--yes');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /root SSH remains enabled/);
    const log = readLog(harness);
    assert.match(log, /_remote-bootstrap-admin/);
    assert.doesNotMatch(log, /_remote-apply/);
    assert.doesNotMatch(log, /-l root .* true/);
  } finally {
    harness.cleanup();
  }
});

for (const scenario of ['ufw-conflict', 'nginx-conflict']) {
  test(`${scenario} aborts before final verification or root rejection`, () => {
    const harness = createHarness({ scenario });
    try {
      const result = invoke(harness, 'apply', '--yes');
      assert.notEqual(result.status, 0);
      const log = readLog(harness);
      assert.match(log, /_remote-apply/);
      assert.doesNotMatch(log, /_remote-verify/);
      assert.doesNotMatch(log, /-l root .* true/);
    } finally {
      harness.cleanup();
    }
  });
}

test('successful first setup validates admin before apply and rejects root last', () => {
  const harness = createHarness();
  try {
    const result = invoke(harness, 'apply', '--yes');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const log = readLog(harness);
    const bootstrap = log.indexOf('_remote-bootstrap-admin');
    const apply = log.indexOf('_remote-apply');
    const verify = log.indexOf('_remote-verify');
    const rootRejection = log.lastIndexOf('-l root');
    assert(bootstrap >= 0);
    assert(apply > bootstrap);
    assert(verify > apply);
    assert(rootRejection > verify);
    assert.match(result.stdout, new RegExp(`User ${administrator}`));
    assert.match(log, new RegExp(`_remote-bootstrap-admin ${administrator}`));
    assert.match(log, new RegExp(`_remote-apply ${administrator} 22`));
  } finally {
    harness.cleanup();
  }
});

test('rerun uses the established administrator path and skips root bootstrap', () => {
  const harness = createHarness({ initialState: 'admin hardened\n' });
  try {
    const result = invoke(harness, 'apply', '--yes');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const log = readLog(harness);
    assert.match(
      result.stdout,
      new RegExp(`Existing ${administrator} administration path`),
    );
    assert.doesNotMatch(log, /_remote-bootstrap-admin/);
    assert.doesNotMatch(log, /test "\$\(id -u\)" -eq 0/);
    assert.match(log, /_remote-apply/);
  } finally {
    harness.cleanup();
  }
});

test('verify is read-only and checks both administrator and root connections', () => {
  const harness = createHarness({ initialState: 'admin hardened\n' });
  try {
    const result = invoke(harness, 'verify');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const log = readLog(harness);
    assert.match(log, /_remote-verify/);
    assert.match(log, /-l root/);
    assert.doesNotMatch(log, /_remote-apply|_remote-bootstrap-admin/);
  } finally {
    harness.cleanup();
  }
});

test('script retains the reviewed destructive-boundary invariants', () => {
  const source = fs.readFileSync(setupScript, 'utf8');
  assert.doesNotMatch(source, /StrictHostKeyChecking=no/);
  assert.doesNotMatch(source, /ufw(?:\s+--force)?\s+reset/);
  assert.doesNotMatch(source, /usg\s+fix/);
  assert.match(source, /pro api u\.pro\.status\.enabled_services\.v1/);
  assert.doesNotMatch(
    source,
    /pro enable --assume-yes esm-infra esm-apps/,
  );
  assert.match(source, /pro help usg/);
  assert.match(source, /skipping the CIS audit/);
  assert.doesNotMatch(source, /ADMIN_USER=mehmet/);
  assert.match(source, /prompt_admin_user/);
  assert.match(source, /validate_admin_user/);
  assert.match(source, /if \[ ! -e "\$admin_home\/\.ssh\/authorized_keys" \]/);
  assert.match(source, /root SSH remains enabled/);
  const firewallFunction = source.match(/configure_firewall\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert(firewallFunction, 'configure_firewall function is missing');
  assert(
    firewallFunction.indexOf('ufw allow "$ssh_port/tcp"')
      < firewallFunction.indexOf('ufw default deny incoming'),
  );
  assert(
    firewallFunction.indexOf('ufw allow "$ssh_port/tcp"')
      < firewallFunction.indexOf('delete_ufw_rules_by_marker galata-ssh'),
  );
  assert.doesNotMatch(firewallFunction, /ufw limit/);
  assert.match(
    firewallFunction,
    /delete_ufw_rules_by_marker galata-ssh "\$ssh_port\/tcp" 'ALLOW IN'/,
  );
  assert.match(firewallFunction, /delete_ufw_rules_by_marker galata-cloudflare-https/);
  assert.doesNotMatch(source, /cloudflare\.com\/ips-v[46]|prepare_cloudflare_ranges/);
  assert.match(source, /https:\/\/pkg\.cloudflare\.com\/cloudflared any main/);
  assert.match(source, /dpkg --compare-versions "\$version" ge 2025\.4\.0/);
  assert.match(source, /\(80\|443\|8080\|3000\|3001\)/);
  assert.match(source, /the previous policy was restored/);
  assert(
    source.indexOf('  install_final_ssh_policy\n')
      > source.indexOf('  install_runtime_foundation\n'),
  );
});
