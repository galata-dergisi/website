// Copyright 2026 Mehmet Baker
//
// Keeps the document head synchronized with the currently visible magazine work.

import {
  READER_REQUEST_TIMEOUT_MS,
  withRequestDeadline,
} from './request-deadline.mjs';

const SEO_SELECTOR = [
  'title',
  'meta[name="description"]',
  'meta[name="language"]',
  'link[rel="canonical"]',
  'meta[property^="og:"]',
  'meta[name^="twitter:"]',
  'meta[property^="article:"]',
  'script[type="application/ld+json"]',
].join(',');

export const HOME_FALLBACK_TITLE = 'Galata Dergisi';

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid SEO document ${label}`);
  }
  return value;
}

function requireUrl(value, label, expectedOrigin) {
  const parsed = new URL(requireString(value, label));
  if (expectedOrigin && parsed.origin !== expectedOrigin) {
    throw new Error(`SEO document ${label} must use ${expectedOrigin}`);
  }
  return parsed.toString();
}

function validateImage(image, label, expectedOrigin) {
  if (!image) return null;
  if (typeof image !== 'object' || Array.isArray(image)) {
    throw new Error(`SEO document ${label} is invalid`);
  }
  requireUrl(image.url, `${label} URL`, expectedOrigin);
  if (image.alt !== undefined && image.alt !== null) {
    requireString(image.alt, `${label} alt text`);
  }
  if (image.type !== undefined && image.type !== null) {
    requireString(image.type, `${label} type`);
  }
  ['width', 'height'].forEach((dimension) => {
    if (
      image[dimension] !== undefined
      && image[dimension] !== null
      && (!Number.isInteger(Number(image[dimension])) || Number(image[dimension]) <= 0)
    ) {
      throw new Error(`SEO document ${label} ${dimension} is invalid`);
    }
  });
  return image;
}

export function validateSeoDocument(document_, expectedOrigin = null) {
  if (!document_ || typeof document_ !== 'object' || Array.isArray(document_)) {
    throw new Error('Invalid SEO document');
  }
  const canonical = requireUrl(document_.canonical, 'canonical', expectedOrigin);
  if (!document_.openGraph || !document_.twitter) {
    throw new Error('SEO document social metadata is missing');
  }
  if (requireUrl(document_.openGraph.url, 'Open Graph URL', expectedOrigin) !== canonical) {
    throw new Error('SEO document Open Graph URL must match its canonical');
  }
  [
    ['title', document_.title],
    ['description', document_.description],
    ['language', document_.language],
    ['Open Graph type', document_.openGraph.type],
    ['Open Graph site name', document_.openGraph.siteName],
    ['Open Graph locale', document_.openGraph.locale],
    ['Open Graph title', document_.openGraph.title],
    ['Open Graph description', document_.openGraph.description],
    ['Twitter card', document_.twitter.card],
    ['Twitter site', document_.twitter.site],
    ['Twitter title', document_.twitter.title],
    ['Twitter description', document_.twitter.description],
  ].forEach(([label, value]) => requireString(value, label));
  if (
    document_.language !== 'tr'
    || document_.openGraph.locale !== 'tr_TR'
    || document_.twitter.site !== '@GalataDergisi'
  ) {
    throw new Error('SEO document publication identity is invalid');
  }
  if (
    document_.openGraph.title !== document_.title
    || document_.twitter.title !== document_.title
    || document_.openGraph.description !== document_.description
    || document_.twitter.description !== document_.description
  ) {
    throw new Error('SEO document title and description variants must match');
  }
  const openGraphImage = validateImage(
    document_.openGraph.image,
    'Open Graph image',
    expectedOrigin,
  );
  const twitterImage = validateImage(
    document_.twitter.image,
    'Twitter image',
    expectedOrigin,
  );
  if (
    Boolean(openGraphImage) !== Boolean(twitterImage)
    || (openGraphImage && (
      openGraphImage.url !== twitterImage.url
      || openGraphImage.alt !== twitterImage.alt
    ))
  ) {
    throw new Error('SEO document social images must match');
  }
  if (
    !document_.structuredData
    || document_.structuredData['@context'] !== 'https://schema.org'
    || !Array.isArray(document_.structuredData['@graph'])
  ) {
    throw new Error('SEO document structured data is invalid');
  }
  if (document_.article) {
    if (
      typeof document_.article !== 'object'
      || !Array.isArray(document_.article.authorUrls)
    ) {
      throw new Error('SEO document article authors are invalid');
    }
    if (document_.article.publishedTime) {
      const published = new Date(document_.article.publishedTime);
      if (Number.isNaN(published.getTime())) {
        throw new Error('SEO document article publication time is invalid');
      }
    }
    if (document_.article.section) {
      requireString(document_.article.section, 'article section');
    }
    document_.article.authorUrls.forEach((authorUrl) => {
      requireUrl(authorUrl, 'article author URL', expectedOrigin);
    });
  }
  return document_;
}

function meta(document_, attribute, key, content) {
  if (content === undefined || content === null || content === '') return null;
  const element = document_.createElement('meta');
  element.setAttribute(attribute, key);
  element.setAttribute('content', String(content));
  return element;
}

function append(fragment, element) {
  if (element) fragment.appendChild(element);
}

function safeStructuredData(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function publisherOrigin(document_) {
  const canonical = document_.head.querySelector
    ? document_.head.querySelector('link[rel="canonical"]')
    : null;
  const canonicalUrl = canonical && (
    canonical.href || canonical.getAttribute('href')
  );
  return canonicalUrl
    ? new URL(canonicalUrl, document_.defaultView.location.href).origin
    : document_.defaultView.location.origin;
}

export function applySeoDocument(document_, seoDocument) {
  const expectedOrigin = document_.defaultView ? publisherOrigin(document_) : null;
  const value = validateSeoDocument(seoDocument, expectedOrigin);
  const fragment = document_.createDocumentFragment();
  const title = document_.createElement('title');
  title.textContent = value.title;
  append(fragment, title);
  append(fragment, meta(document_, 'name', 'description', value.description));
  append(fragment, meta(document_, 'name', 'language', value.language));

  const canonical = document_.createElement('link');
  canonical.setAttribute('rel', 'canonical');
  canonical.setAttribute('href', value.canonical);
  append(fragment, canonical);

  const openGraph = value.openGraph;
  [
    ['og:type', openGraph.type],
    ['og:site_name', openGraph.siteName],
    ['og:locale', openGraph.locale],
    ['og:title', openGraph.title],
    ['og:description', openGraph.description],
    ['og:url', openGraph.url],
  ].forEach(([property, content]) => {
    append(fragment, meta(document_, 'property', property, content));
  });
  if (openGraph.image) {
    [
      ['og:image', openGraph.image.url],
      ['og:image:alt', openGraph.image.alt],
      ['og:image:type', openGraph.image.type],
      ['og:image:width', openGraph.image.width],
      ['og:image:height', openGraph.image.height],
    ].forEach(([property, content]) => {
      append(fragment, meta(document_, 'property', property, content));
    });
  }

  const twitter = value.twitter;
  [
    ['twitter:card', twitter.card],
    ['twitter:site', twitter.site],
    ['twitter:title', twitter.title],
    ['twitter:description', twitter.description],
  ].forEach(([name, content]) => {
    append(fragment, meta(document_, 'name', name, content));
  });
  if (twitter.image) {
    append(fragment, meta(document_, 'name', 'twitter:image', twitter.image.url));
    append(fragment, meta(document_, 'name', 'twitter:image:alt', twitter.image.alt));
  }

  if (value.article) {
    append(fragment, meta(
      document_,
      'property',
      'article:published_time',
      value.article.publishedTime,
    ));
    append(fragment, meta(
      document_,
      'property',
      'article:section',
      value.article.section,
    ));
    value.article.authorUrls.forEach((authorUrl) => {
      append(fragment, meta(document_, 'property', 'article:author', authorUrl));
    });
  }

  const structuredData = document_.createElement('script');
  structuredData.setAttribute('type', 'application/ld+json');
  structuredData.textContent = safeStructuredData(value.structuredData);
  append(fragment, structuredData);

  document_.head.querySelectorAll(SEO_SELECTOR).forEach((element) => element.remove());
  document_.head.appendChild(fragment);
  return value;
}

export function applyOptionalHomeSeoDocument(
  document_,
  seoDocument,
  onWarning = (...args) => console.warn(...args),
) {
  if (seoDocument) {
    try {
      applySeoDocument(document_, seoDocument);
      return seoDocument.title;
    } catch (error) {
      onWarning('Homepage SEO metadata could not be applied.', error);
    }
  } else {
    onWarning('Homepage SEO metadata is unavailable.');
  }

  document_.title = HOME_FALLBACK_TITLE;
  return HOME_FALLBACK_TITLE;
}

export function validateIssueSeo(payload, issue, expectedOrigin) {
  const issueNumber = Number(issue);
  const issueRoute = `/dergiler/sayi${issueNumber}`;
  if (
    !payload
    || payload.success !== true
    || payload.version !== 1
    || Number(payload.issue) !== issueNumber
    || !Number.isInteger(issueNumber)
    || issueNumber <= 0
    || !payload.pages
    || Array.isArray(payload.pages)
    || !payload.documents
    || Array.isArray(payload.documents)
  ) {
    throw new Error(`Invalid SEO index for issue ${issue}`);
  }
  const home = validateSeoDocument(payload.home, expectedOrigin);
  if (new URL(home.canonical).pathname !== '/') {
    throw new Error('SEO index homepage path mismatch');
  }
  Object.entries(payload.documents).forEach(([pathname, document_]) => {
    const validated = validateSeoDocument(document_, expectedOrigin);
    if (
      new URL(validated.canonical).pathname !== pathname
      || !new RegExp(`^${issueRoute}(?:/\\d+)?$`).test(pathname)
    ) {
      throw new Error(`SEO document path mismatch: ${pathname}`);
    }
  });
  Object.entries(payload.pages).forEach(([page, mapping]) => {
    const expectedRoute = page === '1' ? issueRoute : `${issueRoute}/${page}`;
    if (
      !/^[1-9]\d*$/.test(page)
      || !mapping
      || mapping.route !== expectedRoute
      || typeof mapping.document !== 'string'
      || !payload.documents[mapping.document]
    ) {
      throw new Error(`Invalid SEO page mapping for issue ${issue}, page ${page}`);
    }
  });
  return payload;
}

export function resolveIssueSeoPage(payload, page, hash = '') {
  const pageNumber = Number(page);
  const mapping = payload.pages[String(pageNumber)];
  const document_ = mapping && payload.documents[mapping.document];
  if (!mapping || !document_) {
    throw new Error(`SEO metadata is unavailable for page ${pageNumber}`);
  }
  if (hash && (typeof hash !== 'string' || !/^#[^\s]*$/.test(hash))) {
    throw new Error(`Invalid SEO navigation fragment: ${hash}`);
  }
  return {
    route: `${mapping.route}${hash}`,
    document: document_,
  };
}

export async function loadIssueSeo(issue, {
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = READER_REQUEST_TIMEOUT_MS,
  timers = globalThis,
  document_ = globalThis.document,
} = {}) {
  return withRequestDeadline(async (requestSignal) => {
    const response = await fetchImpl(`/magazines/${Number(issue)}/seo`, {
      signal: requestSignal,
    });
    if (!response.ok) throw new Error(`SEO index request failed: ${response.status}`);
    const payload = await response.json();
    return validateIssueSeo(payload, issue, publisherOrigin(document_));
  }, { signal, timeoutMs, timers });
}
