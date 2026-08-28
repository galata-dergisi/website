// Copyright 2026 Mehmet Baker
//
// Renders trusted repository-authored static pages from Markdown. Raw HTML is
// deliberately disabled so page copy cannot bypass the generated site's HTML
// and CSP policies.

const fs = require('fs');
const MarkdownIt = require('markdown-it');

const FRONT_MATTER_FIELDS = new Set(['title', 'description', 'lead']);

function parseFrontMatter(source, sourceName = 'Markdown page') {
  const normalized = String(source).replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error(`${sourceName} must start with front matter`);
  }
  const closingMarker = normalized.indexOf('\n---\n', 4);
  if (closingMarker === -1) {
    throw new Error(`${sourceName} front matter is not closed`);
  }

  const metadata = {};
  normalized.slice(4, closingMarker).split('\n').forEach((line, index) => {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw new Error(`${sourceName} has invalid front matter on line ${index + 2}`);
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!FRONT_MATTER_FIELDS.has(key)) {
      throw new Error(`${sourceName} has unsupported front matter field: ${key}`);
    }
    if (Object.hasOwn(metadata, key)) {
      throw new Error(`${sourceName} repeats front matter field: ${key}`);
    }
    if (!value) {
      throw new Error(`${sourceName} has an empty front matter field: ${key}`);
    }
    metadata[key] = value;
  });

  FRONT_MATTER_FIELDS.forEach((field) => {
    if (!metadata[field]) {
      throw new Error(`${sourceName} is missing front matter field: ${field}`);
    }
  });
  const markdown = normalized.slice(closingMarker + 5).trim();
  if (!markdown) throw new Error(`${sourceName} has no Markdown content`);

  return { metadata, markdown };
}

function headingSlug(value) {
  return String(value)
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'bolum';
}

function createRenderer() {
  const markdown = new MarkdownIt({
    breaks: false,
    html: false,
    linkify: false,
    typographer: false,
  });
  markdown.renderer.rules.heading_open = (tokens, index, options, environment, renderer) => {
    const heading = tokens[index + 1];
    const baseSlug = headingSlug(heading ? heading.content : '');
    const count = environment.headingSlugs.get(baseSlug) || 0;
    environment.headingSlugs.set(baseSlug, count + 1);
    tokens[index].attrSet('id', count ? `${baseSlug}-${count + 1}` : baseSlug);
    return renderer.renderToken(tokens, index, options);
  };
  return markdown;
}

const markdownRenderer = createRenderer();

function renderMarkdownPageSource(source, sourceName) {
  const { metadata, markdown } = parseFrontMatter(source, sourceName);
  return {
    ...metadata,
    html: markdownRenderer.render(markdown, { headingSlugs: new Map() }),
  };
}

function renderMarkdownPage(filename) {
  return renderMarkdownPageSource(fs.readFileSync(filename, 'utf8'), filename);
}

module.exports = {
  parseFrontMatter,
  renderMarkdownPage,
  renderMarkdownPageSource,
};
