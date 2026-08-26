#!/usr/bin/env node
// Copyright 2026 Mehmet Baker
//
// Deterministic public site generator. The output is content-addressed and
// includes only small application assets; magazine media remains external.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const SeoRenderer = require('./lib/seo-renderer.js');
const { renderAtomFeed } = require('./lib/atom-feed.js');
const { renderSitemap } = require('./lib/sitemap.js');
const { openReadOnly } = require('./lib/sqlite-reader.js');
const StaticPublicContent = require('./lib/static-public-content.js');
const {
  allHomepageImageAssets,
  homepageArtworkSources,
  readHomepageImageManifest,
} = require('./lib/homepage-images.js');
const { readShellAssetManifest } = require('./lib/shell-assets.js');
const { createLegacyInlineAssetTransformer } = require('./lib/legacy-inline-assets.js');
const {
  DEVELOPMENT_RUNTIME_PATH,
  DEVELOPMENT_RUNTIME_SOURCE,
  renderDevelopmentDocument,
} = require('./lib/development-rendering.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATABASE = path.join(REPO_ROOT, 'content/public.sqlite');
const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'internal/site/dist');
const DEFAULT_BASE_URL = 'https://galatadergisi.org';
const CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const DEVELOPMENT_CACHE_CONTROL = 'no-store';

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
  '.atom.xml': 'application/atom+xml; charset=utf-8',
};

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function extensionFor(contentType) {
  const type = contentType.split(';')[0];
  return {
    'application/json': '.json',
    'application/xml': '.xml',
    'application/atom+xml': '.xml',
    'image/svg+xml': '.svg',
    'text/css': '.css',
    'text/html': '.html',
    'text/javascript': '.js',
    'text/plain': '.txt',
  }[type] || '.bin';
}

function isCompressible(contentType) {
  return /^(?:application\/(?:json|xml|atom\+xml)|image\/svg\+xml|text\/)/.test(contentType);
}

function stableJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function ensureRelativePath(outputRoot, filename) {
  const absolute = path.resolve(outputRoot, filename);
  if (!absolute.startsWith(`${path.resolve(outputRoot)}${path.sep}`)) {
    throw new Error(`Refusing to write outside output: ${filename}`);
  }
  return absolute;
}

function removeTree(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }
  fs.readdirSync(target).forEach((entry) => {
    removeTree(path.join(target, entry));
  });
  fs.rmdirSync(target);
}

function parseOptions(arguments_) {
  const positional = [];
  const options = {
    mode: 'production',
    database: null,
    output: null,
    baseUrl: process.env.PUBLIC_BASE_URL || DEFAULT_BASE_URL,
    generationToken: null,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const [name, inlineValue] = argument.split('=', 2);
    const value = inlineValue === undefined ? arguments_[index + 1] : inlineValue;
    if (inlineValue === undefined) index += 1;
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${name} requires a value`);
    }
    if (name === '--mode') options.mode = value;
    else if (name === '--database') options.database = value;
    else if (name === '--output') options.output = value;
    else if (name === '--base-url') options.baseUrl = value;
    else if (name === '--generation-token') options.generationToken = value;
    else throw new Error(`Unknown option: ${name}`);
  }
  if (positional.length > 2) {
    throw new Error('Expected at most a database and output path');
  }
  if (options.database && positional[0]) {
    throw new Error('Database path was provided twice');
  }
  if (options.output && positional[1]) {
    throw new Error('Output path was provided twice');
  }
  options.database = path.resolve(options.database || positional[0] || DEFAULT_DATABASE);
  options.output = path.resolve(options.output || positional[1] || DEFAULT_OUTPUT);
  options.baseUrl = options.baseUrl.replace(/\/+$/, '');
  if (!['production', 'development'].includes(options.mode)) {
    throw new Error('--mode must be production or development');
  }
  if (options.mode === 'development' && !options.generationToken) {
    throw new Error('--generation-token is required in development mode');
  }
  if (options.mode === 'production' && options.generationToken) {
    throw new Error('--generation-token is development-only');
  }
  return options;
}

function main(arguments_ = process.argv.slice(2)) {
  const options = parseOptions(arguments_);
  const databasePath = options.database;
  const outputRoot = options.output;
  const baseUrl = options.baseUrl;
  const development = options.mode === 'development';
  const assetManifest = development ? null : readShellAssetManifest(REPO_ROOT);
  const legacyInlineAssets = createLegacyInlineAssetTransformer((pathname) => (
    assetManifest ? assetManifest.assets[pathname].url : pathname
  ));
  const homepageImages = readHomepageImageManifest(REPO_ROOT);
  const reader = openReadOnly(databasePath);
  let publicContent;
  try {
    publicContent = new StaticPublicContent(reader, {
      homepageImages,
    });
  } finally {
    reader.close();
  }

  const renderer = new SeoRenderer({
    templatePath: path.join(REPO_ROOT, 'client/pages/homepage/index.html'),
    ssrBundlePath: path.join(REPO_ROOT, 'build/ssr/HomePage.cjs'),
    baseUrl,
    publicRoot: path.join(REPO_ROOT, 'public'),
    mediaMetadata: publicContent.mediaMetadataByPath,
    assetManifest,
    homepageArtwork: homepageArtworkSources(homepageImages),
  });
  if (!renderer.getSsrRenderer()) {
    throw new Error('SSR bundle is missing. Run the Vite client build first.');
  }

  removeTree(outputRoot);
  fs.mkdirSync(path.join(outputRoot, 'files'), { recursive: true });

  const routes = {};
  const redirects = {};
  const writtenFiles = new Set();

  function store(content, contentType, routeOptions = {}) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const digest = sha256(buffer);
    const extension = extensionFor(contentType);
    const relativeFile = `files/${digest}${extension}`;
    if (!writtenFiles.has(relativeFile)) {
      fs.writeFileSync(ensureRelativePath(outputRoot, relativeFile), buffer);
      writtenFiles.add(relativeFile);
    }
    let gzipFile;
    if (isCompressible(contentType)) {
      gzipFile = `${relativeFile}.gz`;
      if (!writtenFiles.has(gzipFile)) {
        fs.writeFileSync(
          ensureRelativePath(outputRoot, gzipFile),
          zlib.gzipSync(buffer, { level: 9, mtime: 0 }),
        );
        writtenFiles.add(gzipFile);
      }
    }
    return {
      file: relativeFile,
      ...(gzipFile ? { gzipFile } : {}),
      contentType,
      etag: `"${digest}"`,
      cacheControl: development
        ? DEVELOPMENT_CACHE_CONTROL
        : (routeOptions.cacheControl || CACHE_CONTROL),
      size: buffer.length,
    };
  }

  function addRoute(pathname, content, contentType, routeOptions = {}) {
    if (routes[pathname]) throw new Error(`Duplicate generated route: ${pathname}`);
    const rendered = development && contentType === CONTENT_TYPES['.html']
      ? renderDevelopmentDocument(content, options.generationToken)
      : content;
    routes[pathname] = store(rendered, contentType, routeOptions);
  }

  function aliasRoute(alias, canonical) {
    if (!routes[canonical]) throw new Error(`Missing canonical route: ${canonical}`);
    routes[alias] = routes[canonical];
  }

  const magazines = publicContent.getPublishedMagazines();
  const homeMetadata = renderer.createHomeMetadata(magazines);
  const homeSeoDocument = renderer.createSeoDocument(homeMetadata);
  addRoute('/', renderer.renderDocument({
    initialMagazines: magazines,
    initialMagazineIndex: null,
    initialPages: null,
    initialAudioPlayers: null,
    initialLandingPage: 1,
    initialWorkStartPage: null,
    initialWorkEndPage: null,
  }, homeMetadata), CONTENT_TYPES['.html']);

  const magazineList = stableJson({
    success: true,
    magazines: magazines.map((magazine) => ({
      index: magazine.index,
      publishDateText: magazine.publishDateText,
      thumbnailURL: magazine.thumbnailURL,
      thumbnailSources: magazine.thumbnailSources,
      tableOfContents: magazine.tableOfContents,
    })),
  });
  addRoute('/magazines', magazineList, CONTENT_TYPES['.json']);
  aliasRoute('/magazines/', '/magazines');

  let generatedPageRoutes = 0;
  const feedEntries = [];
  magazines.slice().sort((left, right) => left.index - right.index)
    .forEach((magazine) => {
      const issue = publicContent.getIssue(magazine.index);
      const preparedPages = publicContent.prepareIssuePages(magazine.index, issue.pages);
      const pages = Object.fromEntries(Object.entries(preparedPages.pages).map(
        ([pageNumber, html]) => [
          pageNumber,
          legacyInlineAssets.transform(
            html,
            `issue ${magazine.index} page ${pageNumber}`,
          ),
        ],
      ));
      const { audioPlayers } = preparedPages;
      const pageDataPath = `/magazines/${magazine.index}/pages`;
      addRoute(pageDataPath, stableJson({
        success: true,
        pages,
        audioPlayers,
      }), CONTENT_TYPES['.json']);
      aliasRoute(`${pageDataPath}/`, pageDataPath);

      const pageNumbers = Object.keys(pages)
        .map(Number)
        .sort((left, right) => left - right);
      const rootPath = `/dergiler/sayi${magazine.index}`;
      const coverWork = publicContent.getWorkForPage(magazine.index, 1);
      const issueWorks = publicContent.getWorksForIssue(magazine.index);
      const issueMetadata = renderer.createIssueMetadata(
        magazine,
        coverWork && coverWork.kind === 'issue-cover' ? coverWork : null,
        issueWorks,
        pages,
      );
      const canonicalMetadata = new Map([[rootPath, issueMetadata]]);
      const pageSeo = {};
      addRoute(rootPath, renderer.renderDocument({
        initialMagazines: magazines,
        initialMagazineIndex: magazine.index,
        initialPages: pages,
        initialAudioPlayers: audioPlayers,
        initialLandingPage: 1,
        initialWorkStartPage: coverWork ? coverWork.startPage : 1,
        initialWorkEndPage: coverWork ? coverWork.endPage : 1,
      }, issueMetadata), CONTENT_TYPES['.html']);
      redirects[`${rootPath}/`] = rootPath;

      pageNumbers.forEach((pageNumber) => {
        const work = publicContent.getWorkForPage(magazine.index, pageNumber);
        const route = `${rootPath}/${pageNumber}`;
        const canonicalPath = work && work.kind !== 'issue-cover'
          ? `/dergiler/sayi${magazine.index}/${work.startPage}`
          : rootPath;
        if (!canonicalMetadata.has(canonicalPath)) {
          canonicalMetadata.set(
            canonicalPath,
            renderer.createWorkMetadata(magazine, work, pages),
          );
        }
        const metadata = canonicalMetadata.get(canonicalPath);
        pageSeo[String(pageNumber)] = {
          route: pageNumber === 1 ? rootPath : route,
          document: canonicalPath,
        };
        addRoute(route, renderer.renderDocument({
          initialMagazines: magazines,
          initialMagazineIndex: magazine.index,
          initialPages: pages,
          initialAudioPlayers: audioPlayers,
          initialLandingPage: pageNumber,
          initialWorkStartPage: work ? work.startPage : pageNumber,
          initialWorkEndPage: work ? work.endPage : pageNumber,
        }, metadata), CONTENT_TYPES['.html']);
        redirects[`${route}/`] = route;
        generatedPageRoutes += 1;
      });

      const seoDocuments = Object.fromEntries(
        Array.from(canonicalMetadata.entries()).map(([pathname, metadata]) => [
          pathname,
          renderer.createSeoDocument(metadata),
        ]),
      );
      const seoDataPath = `/magazines/${magazine.index}/seo`;
      addRoute(seoDataPath, stableJson({
        success: true,
        version: 1,
        issue: magazine.index,
        home: homeSeoDocument,
        pages: pageSeo,
        documents: seoDocuments,
      }), CONTENT_TYPES['.json']);
      aliasRoute(`${seoDataPath}/`, seoDataPath);

      issueWorks.filter((work) => work.kind !== 'issue-cover').forEach((work) => {
        const canonicalPath = SeoRenderer.workPath(work);
        const metadata = canonicalMetadata.get(canonicalPath);
        if (!metadata) {
          throw new Error(`Missing feed metadata for work: ${canonicalPath}`);
        }
        feedEntries.push({
          title: work.title,
          canonical: seoDocuments[canonicalPath].canonical,
          published: magazine.publishDate,
          magazineIndex: magazine.index,
          startPage: work.startPage,
          authors: work.contributors.map((contributor) => contributor.displayName),
          summary: metadata.description,
          type: work.type,
        });
      });
    });

  publicContent.contributors.forEach((contributor) => {
    const profile = publicContent.getContributorProfile(contributor.id);
    if (!profile) {
      throw new Error(`Contributor ${contributor.id} has no public profile`);
    }
    const canonical = `/katkida-bulunanlar/${profile.id}-${profile.slug}`;
    addRoute(canonical, renderer.renderProfile(profile), CONTENT_TYPES['.html']);
    redirects[`${canonical}/`] = canonical;
  });
  legacyInlineAssets.assertComplete();

  addRoute('/sitemap.xml', renderSitemap(
    baseUrl,
    publicContent.getSitemapData(),
  ), CONTENT_TYPES['.xml']);
  addRoute('/feed.xml', renderAtomFeed(
    baseUrl,
    feedEntries,
  ), CONTENT_TYPES['.atom.xml']);
  addRoute('/robots.txt', development ? [
    'User-agent: *',
    'Disallow: /',
    '',
  ].join('\n') : [
    'User-agent: *',
    'Allow: /',
    `Sitemap: ${baseUrl}/sitemap.xml`,
    '',
  ].join('\n'), CONTENT_TYPES['.txt']);

  if (development) {
    addRoute(
      DEVELOPMENT_RUNTIME_PATH,
      DEVELOPMENT_RUNTIME_SOURCE,
      CONTENT_TYPES['.js'],
    );
  }

  const smallAssets = [
    'assets/contributor-profile.css',
    'assets/contributor-profile.js',
    'assets/legacy/sayi23-page21.css',
    'assets/legacy/sayi45-page34.css',
    'assets/legacy/sayi45-page34.js',
    'assets/legacy/sayi46-page58.css',
    'bundle.css',
    'bundle.js',
    'global.css',
    'service-worker.js',
    'fonts/akaDora.woff2',
    'images/carousel-thumbnail-placeholders.webp',
    'images/bant.jpg',
    'images/bimi.svg',
    'images/favicon.png',
    'images/first-shelf.png',
    'images/header-logo.jpg',
    'images/header-logo.svg',
    'images/wall-bookshelf.png',
  ];
  smallAssets.forEach((asset) => {
    const source = path.join(REPO_ROOT, 'public', asset);
    if (!fs.existsSync(source)) throw new Error(`Missing generated asset: ${asset}`);
    const extension = path.extname(asset).toLowerCase();
    const contentType = CONTENT_TYPES[extension] || 'application/octet-stream';
    addRoute(`/${asset}`, fs.readFileSync(source), contentType);
  });

  allHomepageImageAssets(homepageImages).forEach((asset) => {
    addRoute(
      asset.url,
      fs.readFileSync(path.join(REPO_ROOT, asset.file)),
      asset.contentType,
      { cacheControl: 'public, max-age=31536000, immutable' },
    );
  });

  const notFound = store(`<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>Bulunamadı | Galata Dergisi</title></head>
<body><main><h1>Bulunamadı</h1><p><a href="/">Galata Dergisi</a></p></main></body></html>
`, CONTENT_TYPES['.html']);

  const sortedRoutes = Object.fromEntries(
    Object.entries(routes).sort(([left], [right]) => left.localeCompare(right)),
  );
  const sortedRedirects = Object.fromEntries(
    Object.entries(redirects).sort(([left], [right]) => left.localeCompare(right)),
  );
  const releaseInput = Object.entries(sortedRoutes)
    .map(([pathname, route]) => `${pathname}\0${route.etag}\n`)
    .join('');
  const release = sha256(releaseInput).slice(0, 16);
  const manifest = {
    version: 1,
    release,
    routes: sortedRoutes,
    redirects: sortedRedirects,
    contributorSlugs: Object.fromEntries(
      publicContent.contributors.map((contributor) => [
        String(contributor.id),
        contributor.slug,
      ]),
    ),
    notFound,
    summary: {
      magazines: magazines.length,
      pageVariants: generatedPageRoutes,
      works: publicContent.works.length,
      contributors: publicContent.contributors.length,
      recitations: publicContent.recitations.length,
      inlineMediaContributions: publicContent.media.length,
      routes: Object.keys(sortedRoutes).length,
      uniqueFiles: writtenFiles.size,
    },
  };
  fs.writeFileSync(
    path.join(outputRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({
    output: outputRoot,
    release,
    summary: manifest.summary,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  parseOptions,
};
