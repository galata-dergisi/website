#!/usr/bin/env node
// Copyright 2026 Mehmet Baker
//
// Confirms that release binaries do not contain SQLite and, when a protected
// private-content archive is supplied, do not contain private emails/messages.

const fs = require('fs');
const path = require('path');
const { openReadOnly } = require('./lib/sqlite-reader.js');

const binaries = process.argv.slice(2).map((filename) => path.resolve(filename));
if (!binaries.length) {
  throw new Error('Pass at least one release binary to scan.');
}

function findPrivateArchive() {
  const configured = process.env.PRIVATE_CONTENT_ARCHIVE;
  if (!configured) return null;
  const archive = path.resolve(configured);
  if (!fs.existsSync(archive)) {
    throw new Error(`Private-content archive does not exist: ${archive}`);
  }
  return archive;
}

function privateNeedles(databasePath) {
  if (!databasePath) return [];
  const reader = openReadOnly(databasePath);
  try {
    const tables = new Set(reader.all(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).map((row) => row.name));
    const values = [];
    if (tables.has('assets')) {
      const columns = new Set(reader.all('PRAGMA table_info("assets")')
        .map((column) => column.name));
      const selected = [
        'contributorEmail', 'email', 'message', 'video',
        'driveId', 'driveLink',
      ].filter((column) => columns.has(column));
      if (selected.length) {
        reader.all(`
          SELECT ${selected.map((column) => `"${column}"`).join(', ')}
          FROM assets
        `).forEach((row) => {
          Object.entries(row).forEach(([column, value]) => {
            if (column !== 'message' || String(value || '').trim().length >= 32) {
              values.push(value);
            }
          });
        });
      }
    }
    if (tables.has('contributors')) {
      const columns = new Set(reader.all('PRAGMA table_info("contributors")')
        .map((column) => column.name));
      if (columns.has('email')) {
        reader.all(`
          SELECT email FROM contributors WHERE email IS NOT NULL
        `).forEach((row) => values.push(row.email));
      }
    }
    if (tables.has('settings')) {
      const selected = reader.all('PRAGMA table_info("settings")')
        .map((column) => column.name)
        .filter((column) => column !== 'id' && /^[A-Za-z][A-Za-z0-9_]*$/.test(column));
      if (selected.length) {
        reader.all(`
          SELECT ${selected.map((column) => `"${column}"`).join(', ')}
          FROM settings
        `).forEach((row) => values.push(...Object.values(row)));
      }
    }
    return Array.from(new Set(values
      .map((value) => String(value || '').trim())
      .filter((value) => value.length >= 8)));
  } finally {
    reader.close();
  }
}

const privateArchive = findPrivateArchive();
const needles = [
  'SQLite format 3\u0000',
  ...privateNeedles(privateArchive),
];
if (process.env.TURNSTILE_SECRET_KEY) needles.push(process.env.TURNSTILE_SECRET_KEY);

binaries.forEach((binary) => {
  if (!fs.existsSync(binary)) throw new Error(`Missing binary: ${binary}`);
  const content = fs.readFileSync(binary);
  needles.forEach((needle) => {
    if (content.indexOf(Buffer.from(needle)) !== -1) {
      throw new Error(
        `Release scan failed: ${path.basename(binary)} contains a prohibited value.`,
      );
    }
  });
});

process.stdout.write(`${JSON.stringify({
  ok: true,
  binaries: binaries.map((binary) => path.basename(binary)),
  privateValuesChecked: Math.max(0, needles.length - 1),
  privateArchiveChecked: Boolean(privateArchive),
}, null, 2)}\n`);
