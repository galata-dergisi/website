// Copyright 2026 Mehmet Baker
//
// Browser-equivalent HTML parsing shared by generated-site security checks and
// historical catalog transformations. Source offsets let callers change only
// reviewed elements without reserializing legacy markup.

const { parse, parseFragment } = require('parse5');

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const inertInlineScriptTypes = new Set([
  'application/json',
  'application/ld+json',
]);

function elementRecord(node) {
  const location = node.sourceCodeLocation || null;
  return Object.freeze({
    attributes: new Map((node.attrs || []).map(({ name, value }) => [
      String(name).toLowerCase(),
      value,
    ])),
    contentEndOffset: location?.endTag?.startOffset ?? null,
    contentStartOffset: location?.startTag?.endOffset ?? null,
    endOffset: location?.endOffset ?? null,
    hasExplicitEndTag: Boolean(location?.endTag),
    namespaceURI: node.namespaceURI || null,
    startOffset: location?.startOffset ?? null,
    tagName: String(node.tagName || '').toLowerCase(),
  });
}

function collectHtmlElements(source, { fragment = false } = {}) {
  const input = String(source);
  const root = fragment
    ? parseFragment(input, { sourceCodeLocationInfo: true })
    : parse(input, { sourceCodeLocationInfo: true });
  const elements = [];

  function visit(node) {
    if (node.tagName) elements.push(elementRecord(node));
    for (const child of node.childNodes || []) visit(child);
    if (node.content) visit(node.content);
  }

  visit(root);
  return elements;
}

function applyHtmlReplacements(source, replacements) {
  const input = String(source);
  const ordered = Array.from(replacements || []).map((replacement, index) => {
    const start = replacement?.start;
    const end = replacement?.end;
    if (
      !Number.isInteger(start)
      || !Number.isInteger(end)
      || start < 0
      || end < start
      || end > input.length
    ) {
      throw new Error(`Invalid HTML replacement range at index ${index}: ${start}-${end}`);
    }
    return {
      start,
      end,
      content: String(replacement.content ?? ''),
    };
  }).sort((left, right) => left.start - right.start || left.end - right.end);

  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start < ordered[index - 1].end) {
      throw new Error(
        `Overlapping HTML replacement ranges: ${ordered[index - 1].start}-${ordered[index - 1].end}`
        + ` and ${ordered[index].start}-${ordered[index].end}`,
      );
    }
  }

  return ordered.reverse().reduce((result, replacement) => (
    `${result.slice(0, replacement.start)}${replacement.content}${result.slice(replacement.end)}`
  ), input);
}

function assertClosedHtmlElement(element, context) {
  if (element.namespaceURI !== HTML_NAMESPACE) {
    throw new Error(`${context} contains an unsupported ${element.tagName} namespace`);
  }
  if (
    element.startOffset === null
    || element.endOffset === null
    || element.contentStartOffset === null
    || element.contentEndOffset === null
    || !element.hasExplicitEndTag
  ) {
    throw new Error(`${context} contains a ${element.tagName} without an explicit closing tag`);
  }
}

function inlineScriptDisposition(element) {
  if (element.attributes.has('src')) return 'external';
  const type = String(element.attributes.get('type') || '').trim().toLowerCase();
  return inertInlineScriptTypes.has(type) ? 'inert' : 'executable';
}

function elementContent(source, element) {
  return String(source).slice(element.contentStartOffset, element.contentEndOffset);
}

module.exports = {
  HTML_NAMESPACE,
  applyHtmlReplacements,
  assertClosedHtmlElement,
  collectHtmlElements,
  elementContent,
  inlineScriptDisposition,
};
