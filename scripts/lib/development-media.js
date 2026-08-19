// Copyright 2026 Mehmet Baker
//
// Catalog-driven local media inventory used by the development orchestrator.

const fs = require('fs');
const path = require('path');

const contentUrlPatterns = [
  /https?:\/\/[^\s"'<>]+|\/images\/[^\s"'()<>]+/gi,
  /\/magazines\/sayi\d+\/audio\/[^\s"'()<>]+\.mp3(?:[?#][^\s"'()<>]*)?/gi,
];
const audioUrlPattern = /^\/magazines\/sayi([1-9][0-9]*)\/audio\/(.+)$/;

function addReference(references, publicPath, source) {
  if (!publicPath || !String(publicPath).startsWith('/')) return;
  const normalized = String(publicPath).split(/[?#]/, 1)[0];
  if (!references.has(normalized)) references.set(normalized, new Set());
  references.get(normalized).add(source);
}

function collectDevelopmentMedia(reader) {
  const references = new Map();
  reader.all(`
    SELECT id, thumbnailURL FROM magazines ORDER BY id
  `).forEach((magazine) => {
    addReference(
      references,
      magazine.thumbnailURL,
      `magazine ${Number(magazine.id)} thumbnail`,
    );
  });
  reader.all(`
    SELECT magazineIndex, pageNumber, content
    FROM pages ORDER BY magazineIndex, pageNumber
  `).forEach((page) => {
    const matches = contentUrlPatterns.flatMap(
      (pattern) => String(page.content || '').match(pattern) || [],
    );
    matches.filter((value) => value.startsWith('/')).forEach((value) => {
      addReference(
        references,
        value,
        `magazine ${Number(page.magazineIndex)} page ${Number(page.pageNumber)}`,
      );
    });
  });
  reader.all(`
    SELECT id, mediaPath FROM published_work_media ORDER BY id
  `).forEach((media) => {
    addReference(
      references,
      media.mediaPath,
      `published media ${Number(media.id)}`,
    );
  });
  reader.all(`
    SELECT id, mp3Path FROM audio_recitations ORDER BY id
  `).forEach((recitation) => {
    addReference(
      references,
      recitation.mp3Path,
      `recitation ${Number(recitation.id)} mp3Path`,
    );
  });
  return references;
}

function relativeMediaPath(publicPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(publicPath);
  } catch (error) {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  const segments = decoded.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  if (decoded.startsWith('/images/')) {
    return decoded.slice(1);
  }
  const audio = decoded.match(audioUrlPattern);
  if (audio) {
    return path.posix.join('audio', `sayi${audio[1]}`, audio[2]);
  }
  return null;
}

function inspectDevelopmentMedia(mediaRoot, references) {
  const missing = [];
  const invalid = [];
  const resolvedRoot = path.resolve(mediaRoot);
  let realRoot;
  try {
    realRoot = fs.realpathSync(resolvedRoot);
  } catch (error) {
    realRoot = resolvedRoot;
  }
  [...references.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([publicPath, sources]) => {
      const relative = relativeMediaPath(publicPath);
      const detail = {
        publicPath,
        sources: [...sources].sort(),
      };
      if (!relative) {
        invalid.push(detail);
        return;
      }
      const filename = path.resolve(resolvedRoot, relative);
      if (!filename.startsWith(`${resolvedRoot}${path.sep}`)) {
        invalid.push(detail);
        return;
      }
      try {
        if (!fs.statSync(filename).isFile()) {
          missing.push(detail);
          return;
        }
        const realFile = fs.realpathSync(filename);
        if (!realFile.startsWith(`${realRoot}${path.sep}`)) invalid.push(detail);
      } catch (error) {
        missing.push(detail);
      }
    });
  return {
    mediaRoot: resolvedRoot,
    checked: references.size,
    missing,
    invalid,
  };
}

function formatMediaProblems(report) {
  const lines = [
    `Local development media is incomplete under ${report.mediaRoot}.`,
  ];
  if (report.missing.length) {
    lines.push(`Missing files (${report.missing.length}):`);
    report.missing.forEach((item) => {
      lines.push(`  ${item.publicPath} (${item.sources.join(', ')})`);
    });
  }
  if (report.invalid.length) {
    lines.push(`Invalid local media paths (${report.invalid.length}):`);
    report.invalid.forEach((item) => {
      lines.push(`  ${item.publicPath} (${item.sources.join(', ')})`);
    });
  }
  return lines.join('\n');
}

function validateDevelopmentMedia(mediaRoot, reader) {
  const references = collectDevelopmentMedia(reader);
  const report = inspectDevelopmentMedia(mediaRoot, references);
  if (report.missing.length || report.invalid.length) {
    const error = new Error(formatMediaProblems(report));
    error.report = report;
    throw error;
  }
  return report;
}

module.exports = {
  collectDevelopmentMedia,
  formatMediaProblems,
  inspectDevelopmentMedia,
  relativeMediaPath,
  validateDevelopmentMedia,
};
