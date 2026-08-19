#!/usr/bin/env node
// Copyright 2026 Mehmet Baker

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(
  process.argv[2] || path.join(__dirname, '../internal/site/dist'),
);

function compareCodepoint(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareCodepoint(left.name, right.name))
    .flatMap((entry) => {
      const filename = path.join(directory, entry.name);
      return entry.isDirectory() ? filesIn(filename) : [filename];
    });
}

filesIn(root).forEach((filename) => {
  const digest = crypto.createHash('sha256')
    .update(fs.readFileSync(filename))
    .digest('hex');
  process.stdout.write(
    `${digest}  ${path.relative(root, filename).split(path.sep).join('/')}\n`,
  );
});
