#!/usr/bin/env node
// Copyright 2026 Mehmet Baker

const path = require('path');
const {
  validateDevelopmentMedia,
} = require('./lib/development-media.js');
const { openReadOnly } = require('./lib/sqlite-reader.js');

const repoRoot = path.resolve(__dirname, '..');
const mediaRoot = path.resolve(process.argv[2] || path.join(repoRoot, 'public'));
const databasePath = path.resolve(
  process.argv[3] || path.join(repoRoot, 'content/public.sqlite'),
);
const reader = openReadOnly(databasePath);
try {
  const report = validateDevelopmentMedia(mediaRoot, reader);
  process.stdout.write(
    `Validated ${report.checked} local media references under ${report.mediaRoot}.\n`,
  );
} finally {
  reader.close();
}
