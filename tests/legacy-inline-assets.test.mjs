import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  browserSourceHash,
  createLegacyInlineAssetTransformer,
} = require('../scripts/lib/legacy-inline-assets.js');
const {
  collectHtmlElements,
  inlineScriptDisposition,
} = require('../scripts/lib/html-policy.js');

const reviewedLegacyScript = [
  '',
  '  setTimeout(function () {',
  "    var playDiv = document.querySelector('.video-play-button');",
  "    var videoMask = document.querySelector('.video-mask');",
  '    ',
  "    playDiv.addEventListener('click', function () {",
  '        document',
  "          .querySelector('.back-video')",
  '          .play();',
  "        playDiv.classList.add('hide');",
  "        videoMask.classList.add('hide');",
  '       });',
  '  }, 10);',
  '',
].join('\r\n');

test('browser source hashes normalize CRLF and bare CR line endings', () => {
  const expected = crypto.createHash('sha256').update('first\nsecond\nthird').digest('base64');
  assert.equal(browserSourceHash('first\r\nsecond\rthird'), expected);
});

test('reviewed catalog blocks become same-origin assets and unknown blocks fail closed', () => {
  const transformer = createLegacyInlineAssetTransformer(
    (pathname) => `${pathname}?v=reviewed`,
  );
  const transformed = transformer.transform(
    '<style>\r\r\ntd {\r\r\ntext-align:center;\r\r\n}\r\r\n</style>',
    'issue 23 page 21',
  );
  assert.equal(
    transformed,
    '<link rel="stylesheet" href="/assets/legacy/sayi23-page21.css?v=reviewed" />',
  );
  assert.equal(
    transformer.transform(`<script>${reviewedLegacyScript}</script>`),
    '<script src="/assets/legacy/sayi45-page34.js?v=reviewed"></script>',
  );
  assert.equal(
    transformer.transform(`<script>${reviewedLegacyScript}</script >`),
    '<script src="/assets/legacy/sayi45-page34.js?v=reviewed"></script>',
  );
  assert.throws(
    () => transformer.transform('<script>alert(1)</script>', 'unreviewed page'),
    /unreviewed inline script/,
  );
  assert.throws(() => transformer.assertComplete(), /no longer present/);
});

test('catalog-authored script sources fail closed', () => {
  const transformer = createLegacyInlineAssetTransformer();
  [
    '<script src="/images/sayi45/payload.js"></script>',
    "<script src='/images/sayi45/payload.js'></script>",
    '<script src=/images/sayi45/payload.js></script>',
    '<script src=""></script>',
    '<script src></script>',
    '<script data-note=">" src="&#47;images/sayi45/payload.js"></script>',
  ].forEach((source) => {
    assert.throws(
      () => transformer.transform(source, 'issue 45 page 36'),
      /issue 45 page 36 contains an unreviewed catalog script source/,
    );
  });
});

test('source-less inert script data remains unchanged', () => {
  const transformer = createLegacyInlineAssetTransformer();
  [
    [
      '<script type="application/json" data-note="contains src=/not-an-attribute">',
      '{"reviewed":true}</script>',
    ].join(''),
    '<script type="application/ld+json">{"@type":"Person"}</script>',
    '<script type="application&#47;json">{"reviewed":true}</script>',
  ].forEach((source) => assert.equal(transformer.transform(source), source));
});

test('browser-equivalent parsing rejects executable script syntax variants', () => {
  const transformer = createLegacyInlineAssetTransformer();
  [
    '<script>alert(1)</script >',
    '<script type="text&#47;javascript">alert(1)</script>',
    '<script type="application&#x2f;javascript">alert(1)</script>',
    '<script type="module"></script>',
    '<script type="importmap">{}</script>',
    '<script type="speculationrules">{}</script>',
    '<script type="text/javascript1.5">alert(1)</script>',
    '<script type="text/plain">unreviewed data</script>',
    '<script type="application/json; charset=utf-8">{}</script>',
    '<script></script>',
    '<script>alert(1)',
    '<script data-note=">">alert(1)</script>',
    '<svg><script>alert(1)</script></svg>',
  ].forEach((source) => {
    assert.throws(
      () => transformer.transform(source, 'adversarial page'),
      /adversarial page contains/,
    );
  });
});

test('parsed attributes match browser decoding and tag-boundary behavior', () => {
  const elements = collectHtmlElements([
    '<script type="text&#47;javascript">alert(1)</script >',
    '<img title=">" onerror="alert(1)">',
  ].join(''), { fragment: true });
  const script = elements.find((element) => element.tagName === 'script');
  const image = elements.find((element) => element.tagName === 'img');

  assert.equal(script.attributes.get('type'), 'text/javascript');
  assert.equal(inlineScriptDisposition(script), 'executable');
  assert.equal(script.hasExplicitEndTag, true);
  assert.equal(image.attributes.get('title'), '>');
  assert.equal(image.attributes.get('onerror'), 'alert(1)');
});

test('reviewed catalog blocks reject unreviewed element attributes', () => {
  const transformer = createLegacyInlineAssetTransformer();
  assert.throws(
    () => transformer.transform(
      '<style media="print">\r\r\ntd {\r\r\ntext-align:center;\r\r\n}\r\r\n</style>',
      'issue 23 page 21',
    ),
    /unreviewed inline style attributes/,
  );
  assert.throws(
    () => transformer.transform(
      `<script type="module" async>${reviewedLegacyScript}</script>`,
      'issue 45 page 36',
    ),
    /unreviewed inline script attributes/,
  );
});
