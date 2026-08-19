// Copyright 2026 Mehmet Baker
//
// Deterministic Atom 1.0 feed rendering for canonical published works.

function escapeXml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function publicationInstant(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Atom publication date: ${value}`);
  }
  return date.toISOString();
}

function compareEntries(left, right) {
  return right.published.localeCompare(left.published)
    || Number(right.magazineIndex) - Number(left.magazineIndex)
    || Number(left.startPage) - Number(right.startPage)
    || left.canonical.localeCompare(right.canonical);
}

function renderAtomFeed(baseUrl, sourceEntries) {
  const origin = baseUrl.replace(/\/+$/, '');
  const feedUrl = `${origin}/feed.xml`;
  const entries = sourceEntries.map((entry) => ({
    ...entry,
    published: publicationInstant(entry.published),
  })).sort(compareEntries);
  if (!entries.length) throw new Error('Atom feed requires at least one work');

  const renderedEntries = entries.map((entry) => [
    '  <entry>',
    `    <title>${escapeXml(entry.title)}</title>`,
    `    <id>${escapeXml(entry.canonical)}</id>`,
    `    <link rel="alternate" type="text/html" href="${escapeXml(entry.canonical)}" />`,
    `    <published>${entry.published}</published>`,
    `    <updated>${entry.published}</updated>`,
    ...(entry.authors || []).map((author) => [
      '    <author>',
      `      <name>${escapeXml(author)}</name>`,
      '    </author>',
    ].join('\n')),
    `    <category term="${escapeXml(entry.type)}" />`,
    `    <summary type="text">${escapeXml(entry.summary)}</summary>`,
    '  </entry>',
  ].join('\n')).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="tr">',
    '  <title>Galata Dergisi</title>',
    '  <subtitle>Tek, düzeleşmeyen dergi.</subtitle>',
    `  <id>${escapeXml(feedUrl)}</id>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(feedUrl)}" />`,
    `  <link rel="alternate" type="text/html" href="${escapeXml(`${origin}/`)}" />`,
    `  <updated>${entries[0].published}</updated>`,
    '  <author>',
    '    <name>Galata Dergisi</name>',
    '  </author>',
    renderedEntries,
    '</feed>',
    '',
  ].join('\n');
}

module.exports = {
  compareEntries,
  escapeXml,
  renderAtomFeed,
};
