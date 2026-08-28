// Copyright 2026 Mehmet Baker
//
// Deterministic sitemap rendering for the immutable site build.

const { workPath } = require('./seo-renderer.js');
const { escapeHtml } = require('./seo-utils.js');

function renderSitemap(baseUrl, data) {
  const newestPublication = data.magazines
    .map((magazine) => magazine.publishDate)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  const urls = [{
    pathname: '/',
    lastModified: newestPublication,
  }, {
    pathname: '/telif-ve-kullanim',
    lastModified: null,
  }];
  data.magazines.forEach((magazine) => {
    urls.push({
      pathname: `/dergiler/sayi${Number(magazine.id)}`,
      lastModified: magazine.publishDate,
    });
  });
  data.works.forEach((work) => {
    urls.push({
      pathname: workPath(work),
      lastModified: work.publishDate,
    });
  });
  data.contributors.forEach((contributor) => {
    urls.push({
      pathname: `/katkida-bulunanlar/${Number(contributor.id)}-${contributor.slug}`,
      lastModified: contributor.lastModified,
    });
  });

  const seenPaths = new Set();
  const entries = urls.filter((entry) => {
    if (seenPaths.has(entry.pathname)) return false;
    seenPaths.add(entry.pathname);
    return true;
  }).map((entry) => {
    const location = new URL(entry.pathname, `${baseUrl}/`).toString();
    const modifiedDate = entry.lastModified ? new Date(entry.lastModified) : null;
    const lastModified = modifiedDate && !Number.isNaN(modifiedDate.getTime())
      ? `<lastmod>${modifiedDate.toISOString()}</lastmod>`
      : '';
    return `<url><loc>${escapeHtml(location)}</loc>${lastModified}</url>`;
  }).join('');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entries,
    '</urlset>',
  ].join('');
}

module.exports = { renderSitemap };
