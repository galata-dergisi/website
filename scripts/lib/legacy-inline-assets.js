// Copyright 2026 Mehmet Baker
//
// Replaces the reviewed executable blocks embedded in historical magazine
// content with tracked same-origin assets. Unknown blocks fail closed so new
// executable catalog content still requires explicit review.

const crypto = require('crypto');
const {
  applyHtmlReplacements,
  assertClosedHtmlElement,
  collectHtmlElements,
  elementContent,
  inlineScriptDisposition,
} = require('./html-policy.js');

const reviewedInlineAssets = Object.freeze([
  Object.freeze({
    kind: 'style',
    hash: 'EOCY4x49B9oZbN9ZeSf5N/0YYCm47srCuKGP67J5uvE=',
    path: '/assets/legacy/sayi23-page21.css',
  }),
  Object.freeze({
    kind: 'style',
    hash: 'fBCMO3bpGuiqP5yM4cpV3A9fgVFl0UMJ2Cq9dZ7HxKA=',
    path: '/assets/legacy/sayi45-page34.css',
  }),
  Object.freeze({
    kind: 'script',
    hash: '6DHvmHIiV2+xm43ZpETiyBjXM3VpISHoXIykN7tm1q8=',
    path: '/assets/legacy/sayi45-page34.js',
  }),
  Object.freeze({
    kind: 'style',
    hash: 'lRE773yilRyXqLTxlMY+ajLNfaosK94TCyu29QH8wzA=',
    path: '/assets/legacy/sayi46-page58.css',
  }),
]);

function browserSourceHash(content) {
  const normalized = String(content).replace(/\r\n?/g, '\n');
  return crypto.createHash('sha256').update(normalized).digest('base64');
}

function assertNoAttributes(kind, attributes, context) {
  if (attributes.size > 0) {
    throw new Error(`${context} contains unreviewed inline ${kind} attributes`);
  }
}

function createLegacyInlineAssetTransformer(resolveAsset = (pathname) => pathname) {
  const reviewedByHash = new Map(reviewedInlineAssets.map((asset) => [asset.hash, asset]));
  const usedHashes = new Set();

  function reviewedAsset(kind, content, context) {
    const hash = browserSourceHash(content);
    const asset = reviewedByHash.get(hash);
    if (!asset || asset.kind !== kind) {
      throw new Error(`${context} contains an unreviewed inline ${kind}: sha256-${hash}`);
    }
    usedHashes.add(hash);
    return resolveAsset(asset.path);
  }

  function transform(source, context = 'catalog content') {
    const input = String(source);
    const replacements = [];
    collectHtmlElements(input, { fragment: true })
      .filter((element) => ['script', 'style'].includes(element.tagName))
      .forEach((element) => {
        assertClosedHtmlElement(element, context);
        if (element.tagName === 'style') {
          assertNoAttributes('style', element.attributes, context);
          const href = reviewedAsset('style', elementContent(input, element), context);
          replacements.push({
            start: element.startOffset,
            end: element.endOffset,
            content: `<link rel="stylesheet" href="${href}" />`,
          });
          return;
        }

        if (element.attributes.has('src')) {
          throw new Error(`${context} contains an unreviewed catalog script source`);
        }
        if (inlineScriptDisposition(element) === 'inert') return;
        assertNoAttributes('script', element.attributes, context);
        const src = reviewedAsset('script', elementContent(input, element), context);
        replacements.push({
          start: element.startOffset,
          end: element.endOffset,
          content: `<script src="${src}"></script>`,
        });
      });

    return applyHtmlReplacements(input, replacements);
  }

  function assertComplete() {
    reviewedInlineAssets.forEach((asset) => {
      if (!usedHashes.has(asset.hash)) {
        throw new Error(`Reviewed inline asset is no longer present: ${asset.path}`);
      }
    });
  }

  return Object.freeze({ assertComplete, transform });
}

module.exports = {
  browserSourceHash,
  createLegacyInlineAssetTransformer,
  reviewedInlineAssets,
};
