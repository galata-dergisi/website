import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  findChromeExecutable,
  launchDevToolsBrowser,
} from '../scripts/lib/chrome-devtools-launcher.mjs';

function createFakeBrowser(behavior) {
  const root = mkdtempSync(path.join(tmpdir(), 'galata-chrome-launcher-test-'));
  const executable = path.join(root, 'fake-browser.mjs');
  const recordPath = path.join(root, 'launches.jsonl');
  const statePath = path.join(root, 'state.txt');
  const source = `#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const argument = (name) => process.argv
  .find((value) => value.startsWith(name + '='))
  ?.slice(name.length + 1);
const profile = argument('--user-data-dir');
const recordPath = argument('--test-record');
const statePath = argument('--test-state');
appendFileSync(recordPath, JSON.stringify({ pid: process.pid, profile }) + '\\n');
${behavior}
setInterval(() => {}, 1_000);
`;
  writeFileSync(executable, source);
  chmodSync(executable, 0o755);
  return { executable, recordPath, root, statePath };
}

function launchFakeBrowser(fixture, options = {}) {
  return launchDevToolsBrowser({
    executable: fixture.executable,
    extraArguments: [
      `--test-record=${fixture.recordPath}`,
      `--test-state=${fixture.statePath}`,
    ],
    onRetry: options.onRetry || (() => {}),
    profilePrefix: 'galata-chrome-launcher-profile-',
    shutdownTimeoutMilliseconds: options.shutdownTimeoutMilliseconds ?? 100,
    startupAttempts: options.startupAttempts ?? 1,
    startupTimeoutMilliseconds: options.startupTimeoutMilliseconds ?? 1_500,
  });
}

function readLaunches(fixture) {
  if (!existsSync(fixture.recordPath)) return [];
  return readFileSync(fixture.recordPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function cleanupFixture(fixture) {
  for (const launch of readLaunches(fixture)) {
    if (processIsRunning(launch.pid)) process.kill(launch.pid, 'SIGKILL');
  }
  rmSync(fixture.root, { recursive: true, force: true });
}

test('discovers a silent browser through DevToolsActivePort', async () => {
  const fixture = createFakeBrowser(`
writeFileSync(
  path.join(profile, 'DevToolsActivePort'),
  '9222\\n/devtools/browser/marker-only\\n',
);
`);
  let browser;
  try {
    assert.equal(findChromeExecutable({
      candidates: [path.join(fixture.root, 'missing'), fixture.executable],
    }), fixture.executable);
    browser = await launchFakeBrowser(fixture);
    assert.equal(browser.websocketURL, 'ws://127.0.0.1:9222/devtools/browser/marker-only');

    const [launch] = readLaunches(fixture);
    assert.equal(existsSync(launch.profile), true);
    await browser.close();
    assert.equal(existsSync(launch.profile), false);
    assert.equal(processIsRunning(launch.pid), false);
  } finally {
    await browser?.close();
    cleanupFixture(fixture);
  }
});

test('retains stderr readiness as a fallback', async () => {
  const fixture = createFakeBrowser(`
process.stderr.write('DevTools listening on ws://127.0.0.1:9333/devtools/browser/stderr-only\\n');
`);
  let browser;
  try {
    browser = await launchFakeBrowser(fixture);
    assert.equal(browser.websocketURL, 'ws://127.0.0.1:9333/devtools/browser/stderr-only');
  } finally {
    await browser?.close();
    cleanupFixture(fixture);
  }
});

test('cleans a hung attempt and retries with a fresh profile', async () => {
  const fixture = createFakeBrowser(`
const attempt = existsSync(statePath) ? Number(readFileSync(statePath, 'utf8')) + 1 : 1;
writeFileSync(statePath, String(attempt));
if (attempt === 2) {
  writeFileSync(
    path.join(profile, 'DevToolsActivePort'),
    '9444\\n/devtools/browser/retried\\n',
  );
}
`);
  const retries = [];
  let browser;
  try {
    browser = await launchFakeBrowser(fixture, {
      onRetry: (retry) => retries.push(retry),
      startupAttempts: 2,
      startupTimeoutMilliseconds: 1_500,
    });
    assert.equal(browser.websocketURL, 'ws://127.0.0.1:9444/devtools/browser/retried');
    assert.equal(retries.length, 1);

    const launches = readLaunches(fixture);
    assert.equal(launches.length, 2);
    assert.notEqual(launches[0].profile, launches[1].profile);
    assert.equal(existsSync(launches[0].profile), false);
    assert.equal(processIsRunning(launches[0].pid), false);
    assert.equal(existsSync(launches[1].profile), true);

    await browser.close();
    assert.equal(existsSync(launches[1].profile), false);
    assert.equal(processIsRunning(launches[1].pid), false);
  } finally {
    await browser?.close();
    cleanupFixture(fixture);
  }
});

test('bounds terminal diagnostics and cleans every failed attempt', async () => {
  const fixture = createFakeBrowser(`
process.stderr.write('discarded-prefix-' + 'x'.repeat(25_000) + '-retained-suffix');
`);
  try {
    await assert.rejects(
      launchFakeBrowser(fixture, {
        startupAttempts: 2,
        startupTimeoutMilliseconds: 1_500,
      }),
      (error) => {
        assert.match(error.message, /failed after 2 startup attempts/);
        assert.match(error.message, /retained-suffix/);
        assert.doesNotMatch(error.message, /discarded-prefix/);
        assert.ok(error.message.length < 20_200);
        return true;
      },
    );

    const launches = readLaunches(fixture);
    assert.equal(launches.length, 2);
    for (const launch of launches) {
      assert.equal(existsSync(launch.profile), false);
      assert.equal(processIsRunning(launch.pid), false);
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test('reports spawn errors and removes each temporary profile', async () => {
  const profilePrefix = `galata-missing-chrome-${process.pid}-${Date.now()}-`;
  await assert.rejects(
    launchDevToolsBrowser({
      executable: path.join(tmpdir(), 'missing-galata-browser'),
      onRetry: () => {},
      profilePrefix,
      shutdownTimeoutMilliseconds: 50,
      startupAttempts: 2,
      startupTimeoutMilliseconds: 100,
    }),
    (error) => {
      assert.match(error.message, /failed after 2 startup attempts/);
      assert.match(error.message, /failed to start/);
      assert.match(error.message, /ENOENT/);
      return true;
    },
  );
  assert.deepEqual(
    readdirSync(tmpdir()).filter((entry) => entry.startsWith(profilePrefix)),
    [],
  );
});

test('force-kills a browser that ignores SIGTERM', async () => {
  const fixture = createFakeBrowser(`
process.on('SIGTERM', () => {});
writeFileSync(
  path.join(profile, 'DevToolsActivePort'),
  '9555\\n/devtools/browser/force-kill\\n',
);
`);
  let browser;
  try {
    browser = await launchFakeBrowser(fixture, { shutdownTimeoutMilliseconds: 50 });
    const [launch] = readLaunches(fixture);
    await browser.close();
    assert.equal(processIsRunning(launch.pid), false);
    assert.equal(existsSync(launch.profile), false);
  } finally {
    await browser?.close();
    cleanupFixture(fixture);
  }
});
