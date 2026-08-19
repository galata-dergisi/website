import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, '..');
const scanner = path.join(projectRoot, 'scripts/scan-release.js');

function runScanner(binary, archive) {
  const environment = {
    ...process.env,
    PRIVATE_CONTENT_ARCHIVE: archive,
  };
  delete environment.TURNSTILE_SECRET_KEY;
  return childProcess.spawnSync(process.execPath, [scanner, binary], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: environment,
  });
}

test('release scan checks an explicitly configured private-content archive', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'galata-release-scan-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));

  const archive = path.join(root, 'private.sqlite');
  const database = new DatabaseSync(archive);
  database.exec(`
    CREATE TABLE assets (
      contributorEmail TEXT,
      message TEXT
    )
  `);
  database.prepare(`
    INSERT INTO assets (contributorEmail, message) VALUES (?, ?)
  `).run(
    'private-person@example.test',
    'This private submission message is deliberately longer than thirty-two characters.',
  );
  database.close();

  const safeBinary = path.join(root, 'safe-release');
  fs.writeFileSync(safeBinary, 'safe release contents');
  const safeResult = runScanner(safeBinary, archive);
  assert.equal(safeResult.status, 0, safeResult.stderr);
  const report = JSON.parse(safeResult.stdout);
  assert.equal(report.privateArchiveChecked, true);
  assert.equal(report.privateValuesChecked, 2);

  const unsafeBinary = path.join(root, 'unsafe-release');
  fs.writeFileSync(unsafeBinary, 'contains private-person@example.test');
  const unsafeResult = runScanner(unsafeBinary, archive);
  assert.notEqual(unsafeResult.status, 0);
  assert.match(unsafeResult.stderr, /contains a prohibited value/);
});

test('release scan rejects a configured archive that does not exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'galata-release-scan-'));
  const binary = path.join(root, 'safe-release');
  fs.writeFileSync(binary, 'safe release contents');
  try {
    const result = runScanner(binary, path.join(root, 'missing.sqlite'));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Private-content archive does not exist/);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
