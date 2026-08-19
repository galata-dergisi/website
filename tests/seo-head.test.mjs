import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyOptionalHomeSeoDocument,
  applySeoDocument,
  HOME_FALLBACK_TITLE,
  loadIssueSeo,
  resolveIssueSeoPage,
  validateIssueSeo,
  validateSeoDocument,
} from '../client/lib/seo-head.mjs';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.parent = null;
    this.textContent = '';
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

class FakeFragment {
  constructor() {
    this.children = [];
  }

  appendChild(element) {
    this.children.push(element);
  }
}

function isSeoElement(element) {
  if (element.tagName === 'TITLE') return true;
  if (element.tagName === 'LINK') return element.getAttribute('rel') === 'canonical';
  if (element.tagName === 'SCRIPT') {
    return element.getAttribute('type') === 'application/ld+json';
  }
  if (element.tagName !== 'META') return false;
  const name = element.getAttribute('name') || '';
  const property = element.getAttribute('property') || '';
  return ['description', 'language'].includes(name)
    || name.startsWith('twitter:')
    || property.startsWith('og:')
    || property.startsWith('article:');
}

class FakeHead {
  constructor() {
    this.children = [];
  }

  appendChild(element) {
    if (element instanceof FakeFragment) {
      element.children.forEach((child) => this.appendChild(child));
      return;
    }
    element.parent = this;
    this.children.push(element);
  }

  querySelectorAll() {
    return this.children.filter(isSeoElement);
  }

  querySelector(selector) {
    if (selector === 'link[rel="canonical"]') {
      return this.children.find((element) => (
        element.tagName === 'LINK'
        && element.getAttribute('rel') === 'canonical'
      )) || null;
    }
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.defaultView = { location: new URL('https://galatadergisi.org/') };
    this.head = new FakeHead();
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  createDocumentFragment() {
    return new FakeFragment();
  }
}

function appendElement(document_, tagName, attributes = {}) {
  const element = document_.createElement(tagName);
  Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
  document_.head.appendChild(element);
  return element;
}

function seoDocument(pathname, type = 'article') {
  const canonical = `https://galatadergisi.org${pathname}`;
  const image = {
    url: 'https://galatadergisi.org/images/sayi1/thumbnail.jpg',
    alt: 'Galata Dergisi Sayı 1 kapağı',
    type: 'image/jpeg',
    width: 180,
    height: 252,
  };
  return {
    title: type === 'article' ? 'Bir Eser | Galata Dergisi' : 'Bir Görsel | Galata Dergisi',
    description: 'Yeterince açıklayıcı ve özgün bir çalışma özeti.',
    language: 'tr',
    canonical,
    openGraph: {
      type,
      siteName: 'Galata Dergisi',
      locale: 'tr_TR',
      title: type === 'article' ? 'Bir Eser | Galata Dergisi' : 'Bir Görsel | Galata Dergisi',
      description: 'Yeterince açıklayıcı ve özgün bir çalışma özeti.',
      url: canonical,
      image,
    },
    twitter: {
      card: 'summary_large_image',
      site: '@GalataDergisi',
      title: type === 'article' ? 'Bir Eser | Galata Dergisi' : 'Bir Görsel | Galata Dergisi',
      description: 'Yeterince açıklayıcı ve özgün bir çalışma özeti.',
      image: { url: image.url, alt: image.alt },
    },
    article: type === 'article' ? {
      publishedTime: '2026-01-01T00:00:00.000Z',
      section: 'Galata Dergisi Sayı 1',
      authorUrls: [
        'https://galatadergisi.org/katkida-bulunanlar/1-ada',
        'https://galatadergisi.org/katkida-bulunanlar/2-deniz',
      ],
    } : null,
    structuredData: {
      '@context': 'https://schema.org',
      '@graph': [{ '@type': type === 'article' ? 'Article' : 'VisualArtwork' }],
    },
  };
}

function matching(document_, tagName, attribute, value) {
  return document_.head.children.filter((element) => (
    element.tagName === tagName.toUpperCase()
    && element.getAttribute(attribute) === value
  ));
}

test('head updates replace every dynamic SEO node and preserve discovery links', () => {
  const document_ = new FakeDocument();
  document_.defaultView.location = new URL('http://127.0.0.1:3101/');
  const charset = appendElement(document_, 'meta', { charset: 'utf-8' });
  const feed = appendElement(document_, 'link', {
    rel: 'alternate',
    type: 'application/atom+xml',
    href: 'https://galatadergisi.org/feed.xml',
  });
  appendElement(document_, 'title').textContent = 'Eski Başlık';
  appendElement(document_, 'link', {
    rel: 'canonical',
    href: 'https://galatadergisi.org/',
  });
  appendElement(document_, 'meta', { property: 'article:author', content: 'old' });

  applySeoDocument(document_, seoDocument('/dergiler/sayi1/7'));
  const titles = document_.head.children.filter((element) => element.tagName === 'TITLE');
  assert.equal(titles.length, 1);
  assert.equal(titles[0].textContent, 'Bir Eser | Galata Dergisi');
  assert.equal(matching(document_, 'meta', 'property', 'article:author').length, 2);
  assert.equal(matching(document_, 'meta', 'name', 'twitter:site')[0].getAttribute('content'), '@GalataDergisi');
  assert.equal(matching(document_, 'link', 'rel', 'canonical').length, 1);

  applySeoDocument(document_, seoDocument('/dergiler/sayi1/22', 'website'));
  assert.equal(matching(document_, 'meta', 'property', 'article:author').length, 0);
  assert.equal(matching(document_, 'meta', 'property', 'article:section').length, 0);
  assert.equal(document_.head.children.filter((element) => element.tagName === 'TITLE').length, 1);
  assert.equal(matching(document_, 'link', 'rel', 'canonical').length, 1);
  assert(document_.head.children.includes(charset));
  assert(document_.head.children.includes(feed));
});

test('homepage metadata restoration remains usable without a valid SEO payload', () => {
  const validDocument = new FakeDocument();
  const home = seoDocument('/', 'website');
  const validWarnings = [];
  assert.equal(
    applyOptionalHomeSeoDocument(
      validDocument,
      home,
      (...args) => validWarnings.push(args),
    ),
    home.title,
  );
  assert.deepEqual(validWarnings, []);
  assert.equal(
    validDocument.head.children.find((element) => element.tagName === 'TITLE').textContent,
    home.title,
  );

  for (const unavailableDocument of [null, { ...home, title: '' }]) {
    const document_ = new FakeDocument();
    const warnings = [];
    assert.equal(
      applyOptionalHomeSeoDocument(
        document_,
        unavailableDocument,
        (...args) => warnings.push(args),
      ),
      HOME_FALLBACK_TITLE,
    );
    assert.equal(document_.title, HOME_FALLBACK_TITLE);
    assert.equal(warnings.length, 1);
  }
});

test('SEO index validation and resolution preserve canonical clusters and fragments', () => {
  const article = seoDocument('/dergiler/sayi1/7');
  const home = seoDocument('/', 'website');
  const payload = {
    success: true,
    version: 1,
    issue: 1,
    home,
    pages: {
      7: { route: '/dergiler/sayi1/7', document: '/dergiler/sayi1/7' },
      8: { route: '/dergiler/sayi1/8', document: '/dergiler/sayi1/7' },
    },
    documents: {
      '/dergiler/sayi1/7': article,
    },
  };
  validateIssueSeo(payload, 1, 'https://galatadergisi.org');
  const continuation = resolveIssueSeoPage(payload, 8, '#ses-1-test');
  assert.equal(continuation.route, '/dergiler/sayi1/8#ses-1-test');
  assert.equal(continuation.document.canonical, article.canonical);
  assert.throws(() => resolveIssueSeoPage(payload, 8, 'bad-fragment'), /Invalid SEO navigation fragment/);
  assert.throws(
    () => validateSeoDocument({
      ...article,
      canonical: 'https://example.com/dergiler/sayi1/7',
    }, 'https://galatadergisi.org'),
    /must use https:\/\/galatadergisi\.org/,
  );
  assert.throws(
    () => validateIssueSeo({
      ...payload,
      pages: {
        ...payload.pages,
        8: { route: '/dergiler/sayi1/99', document: '/dergiler/sayi1/7' },
      },
    }, 1, 'https://galatadergisi.org'),
    /Invalid SEO page mapping/,
  );
  assert.throws(
    () => validateSeoDocument({
      ...article,
      twitter: { ...article.twitter, site: '@UnreviewedAccount' },
    }, 'https://galatadergisi.org'),
    /publication identity is invalid/,
  );
});

test('loads issue SEO through a caller-cancellable request signal', async () => {
  const article = seoDocument('/dergiler/sayi1/7');
  const payload = {
    success: true,
    version: 1,
    issue: 1,
    home: seoDocument('/', 'website'),
    pages: { 7: { route: '/dergiler/sayi1/7', document: '/dergiler/sayi1/7' }},
    documents: { '/dergiler/sayi1/7': article },
  };
  const callerController = new AbortController();
  let requestSignal;
  const loaded = await loadIssueSeo(1, {
    document_: new FakeDocument(),
    signal: callerController.signal,
    fetchImpl: async (url, { signal }) => {
      assert.equal(url, '/magazines/1/seo');
      requestSignal = signal;
      return { ok: true, status: 200, json: async () => payload };
    },
  });

  assert.equal(loaded, payload);
  assert.notEqual(requestSignal, callerController.signal);
  assert.equal(requestSignal.aborted, false);
});
