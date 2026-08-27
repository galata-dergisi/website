import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const maximumStderrCharacters = 20_000;
const defaultStartupAttempts = 2;
const defaultStartupTimeoutMilliseconds = 30_000;
const defaultShutdownTimeoutMilliseconds = 5_000;
const devToolsMarkerPollMilliseconds = 25;

function defaultChromeCandidates() {
  return [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
}

export function findChromeExecutable(options = {}) {
  const browserName = options.browserName || 'Chrome';
  const candidates = options.candidates || defaultChromeCandidates();
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error(`${browserName} not found; set CHROME_BIN to its executable path`);
  }
  return executable;
}

function removeProfile(profile) {
  rmSync(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}

function isRunning(browserProcess) {
  return Number.isInteger(browserProcess.pid)
    && browserProcess.exitCode === null
    && browserProcess.signalCode === null;
}

function waitForExit(browserProcess, timeoutMilliseconds) {
  if (!isRunning(browserProcess)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timeout;
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    browserProcess.once('exit', onExit);
    timeout = setTimeout(() => {
      browserProcess.off('exit', onExit);
      resolve(!isRunning(browserProcess));
    }, timeoutMilliseconds);
  });
}

function launchAttempt(options) {
  const {
    browserName,
    executable,
    extraArguments,
    profilePrefix,
    shutdownTimeoutMilliseconds,
    startupTimeoutMilliseconds,
    windowSize,
  } = options;
  const profile = mkdtempSync(path.join(tmpdir(), profilePrefix));
  const devToolsActivePortPath = path.join(profile, 'DevToolsActivePort');
  let browserProcess;
  try {
    browserProcess = spawn(executable, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      ...extraArguments,
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--window-size=${windowSize}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    removeProfile(profile);
    throw new Error(`${browserName} failed to start: ${error.message}`, { cause: error });
  }

  let stderr = '';
  let closePromise;
  const readiness = new Promise((resolve, reject) => {
    let settled = false;
    let markerPoll;
    let timeout;

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearInterval(markerPoll);
      clearTimeout(timeout);
      callback(value);
    };
    const readDevToolsMarker = () => {
      try {
        const [port, endpointPath] = readFileSync(devToolsActivePortPath, 'utf8')
          .trim()
          .split(/\r?\n/);
        if (/^\d+$/.test(port) && endpointPath?.startsWith('/')) {
          settle(resolve, `ws://127.0.0.1:${port}${endpointPath}`);
        }
      } catch {
        // Chrome can expose the marker between creating and completing it.
        // Keep polling until the file contains both validated lines.
      }
    };

    browserProcess.stderr.setEncoding('utf8');
    browserProcess.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-maximumStderrCharacters);
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) settle(resolve, match[1]);
    });
    browserProcess.on('error', (error) => {
      settle(
        reject,
        new Error(`${browserName} failed to start: ${error.message}\n${stderr}`),
      );
    });
    browserProcess.on('exit', (code, signal) => {
      const status = signal ? `signal ${signal}` : `code ${code}`;
      settle(
        reject,
        new Error(`${browserName} exited before DevTools was ready (${status})\n${stderr}`),
      );
    });
    markerPoll = setInterval(readDevToolsMarker, devToolsMarkerPollMilliseconds);
    timeout = setTimeout(() => {
      settle(
        reject,
        new Error(`${browserName} DevTools endpoint timed out\n${stderr}`),
      );
    }, startupTimeoutMilliseconds);
    readDevToolsMarker();
  });

  return {
    readiness,
    stderr: () => stderr,
    async close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        try {
          if (!isRunning(browserProcess)) return;
          browserProcess.kill('SIGTERM');
          await waitForExit(browserProcess, shutdownTimeoutMilliseconds);
          if (!isRunning(browserProcess)) return;
          browserProcess.kill('SIGKILL');
          await waitForExit(browserProcess, shutdownTimeoutMilliseconds);
          if (isRunning(browserProcess)) {
            throw new Error(`${browserName} did not exit after SIGKILL`);
          }
        } finally {
          removeProfile(profile);
        }
      })();
      return closePromise;
    },
  };
}

export async function launchDevToolsBrowser(options = {}) {
  const browserName = options.browserName || 'Chrome';
  const executable = options.executable || findChromeExecutable({ browserName });
  const extraArguments = options.extraArguments || [];
  const profilePrefix = options.profilePrefix || 'galata-chrome-devtools-';
  const shutdownTimeoutMilliseconds = options.shutdownTimeoutMilliseconds
    ?? defaultShutdownTimeoutMilliseconds;
  const startupAttempts = options.startupAttempts ?? defaultStartupAttempts;
  const startupTimeoutMilliseconds = options.startupTimeoutMilliseconds
    ?? defaultStartupTimeoutMilliseconds;
  const windowSize = options.windowSize || '1200,900';
  let lastError;

  for (let attempt = 1; attempt <= startupAttempts; attempt += 1) {
    let browser;
    try {
      browser = launchAttempt({
        browserName,
        executable,
        extraArguments,
        profilePrefix,
        shutdownTimeoutMilliseconds,
        startupTimeoutMilliseconds,
        windowSize,
      });
      const websocketURL = await browser.readiness;
      return {
        websocketURL,
        stderr: browser.stderr,
        close: browser.close,
      };
    } catch (error) {
      lastError = error;
      await browser?.close();
      if (attempt < startupAttempts) {
        const message = `${browserName} startup attempt ${attempt} failed; retrying.\n${error.message}\n`;
        if (options.onRetry) options.onRetry({ attempt, error, message });
        else process.stderr.write(message);
      }
    }
  }

  throw new Error(
    `${browserName} failed after ${startupAttempts} startup attempts.\n${lastError?.message || ''}`,
    { cause: lastError },
  );
}
