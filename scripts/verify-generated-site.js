#!/usr/bin/env node
// Copyright 2026 Mehmet Baker

const crypto = require('crypto');
const nodeAssert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const iconLibrary = require('../client/lib/font-awesome-icons.js');
const { openReadOnly } = require('./lib/sqlite-reader.js');
const { decodeHtmlEntities } = require('./lib/seo-utils.js');
const {
  applyShellAssetVersions,
  readShellAssetManifest,
  shellAssetEntries,
} = require('./lib/shell-assets.js');

const repoRoot = path.resolve(__dirname, '..');
const siteRoot = path.resolve(process.argv[2] || path.join(repoRoot, 'internal/site/dist'));
const expectedBaseUrl = (process.argv[3] || 'https://galatadergisi.org').replace(/\/+$/, '');
const manifest = JSON.parse(
  fs.readFileSync(path.join(siteRoot, 'manifest.json'), 'utf8'),
);
const shellAssetManifest = readShellAssetManifest(repoRoot);
const reader = openReadOnly(path.join(repoRoot, 'content/public.sqlite'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readEntry(entry, gzip = false) {
  const filename = gzip ? entry.gzipFile : entry.file;
  return fs.readFileSync(path.join(siteRoot, filename));
}

function readRoute(route) {
  return readEntry(manifest.routes[route]).toString();
}

function matchRequired(value, pattern, message) {
  const match = value.match(pattern);
  assert(match, message);
  return match[1];
}

function structuredData(html, route) {
  return JSON.parse(matchRequired(
    html,
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    `${route} structured data missing`,
  ));
}

function metadataValues(html, attribute, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Array.from(html.matchAll(new RegExp(
    `<meta ${attribute}="${escaped}" content="([^"]*)" \\/>`,
    'g',
  ))).map((match) => decodeHtmlEntities(match[1]));
}

function metadataValue(html, attribute, key) {
  return metadataValues(html, attribute, key)[0] || null;
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function atomText(block, element, context) {
  return decodeXml(matchRequired(
    block,
    new RegExp(`<${element}[^>]*>([\\s\\S]*?)<\\/${element}>`),
    `${context} ${element} missing`,
  ));
}

function parseAtomEntries(feed) {
  return Array.from(feed.matchAll(/<entry>([\s\S]*?)<\/entry>/g))
    .map((match, index) => {
      const block = match[1];
      const context = `Atom entry ${index + 1}`;
      return {
        title: atomText(block, 'title', context),
        id: atomText(block, 'id', context),
        alternate: decodeXml(matchRequired(
          block,
          /<link rel="alternate" type="text\/html" href="([^"]+)" \/>/,
          `${context} alternate link missing`,
        )),
        published: atomText(block, 'published', context),
        updated: atomText(block, 'updated', context),
        authors: Array.from(block.matchAll(
          /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g,
        )).map((author) => decodeXml(author[1])),
        category: decodeXml(matchRequired(
          block,
          /<category term="([^"]+)" \/>/,
          `${context} category missing`,
        )),
        summary: atomText(block, 'summary', context),
      };
    });
}

function seoDocument(html, route) {
  const openGraphImage = metadataValue(html, 'property', 'og:image');
  const twitterImage = metadataValue(html, 'name', 'twitter:image');
  const type = metadataValue(html, 'property', 'og:type');
  return {
    title: decodeHtmlEntities(matchRequired(
      html,
      /<title>([\s\S]*?)<\/title>/,
      `${route} title missing`,
    )),
    description: metadataValue(html, 'name', 'description'),
    language: metadataValue(html, 'name', 'language'),
    canonical: matchRequired(
      html,
      /<link rel="canonical" href="([^"]+)" \/>/,
      `${route} canonical missing`,
    ),
    openGraph: {
      type,
      siteName: metadataValue(html, 'property', 'og:site_name'),
      locale: metadataValue(html, 'property', 'og:locale'),
      title: metadataValue(html, 'property', 'og:title'),
      description: metadataValue(html, 'property', 'og:description'),
      url: metadataValue(html, 'property', 'og:url'),
      image: openGraphImage ? {
        url: openGraphImage,
        alt: metadataValue(html, 'property', 'og:image:alt'),
        type: metadataValue(html, 'property', 'og:image:type'),
        width: Number(metadataValue(html, 'property', 'og:image:width')),
        height: Number(metadataValue(html, 'property', 'og:image:height')),
      } : null,
    },
    twitter: {
      card: metadataValue(html, 'name', 'twitter:card'),
      site: metadataValue(html, 'name', 'twitter:site'),
      title: metadataValue(html, 'name', 'twitter:title'),
      description: metadataValue(html, 'name', 'twitter:description'),
      image: twitterImage ? {
        url: twitterImage,
        alt: metadataValue(html, 'name', 'twitter:image:alt'),
      } : null,
    },
    article: type === 'article' ? {
      publishedTime: metadataValue(html, 'property', 'article:published_time'),
      section: metadataValue(html, 'property', 'article:section'),
      authorUrls: metadataValues(html, 'property', 'article:author'),
    } : null,
    structuredData: structuredData(html, route),
  };
}

function seoSignature(html, route) {
  const title = matchRequired(
    html,
    /<title>([\s\S]*?)<\/title>/,
    `${route} title missing`,
  );
  const description = matchRequired(
    html,
    /<meta name="description" content="([^"]*)" \/>/,
    `${route} description missing`,
  );
  const canonical = matchRequired(
    html,
    /<link rel="canonical" href="([^"]+)" \/>/,
    `${route} canonical missing`,
  );
  const social = html.match(
    /<meta (?:property|name)="(?:og:|twitter:|article:)[^>]+>/g,
  ) || [];
  assert(social.some((tag) => tag.includes('og:title')), `${route} Open Graph missing`);
  assert(social.some((tag) => tag.includes('twitter:title')), `${route} Twitter metadata missing`);
  const jsonLd = matchRequired(
    html,
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    `${route} structured data missing`,
  );
  return {
    canonical,
    description,
    value: JSON.stringify({ title, description, canonical, social, jsonLd }),
  };
}

try {
  const development = manifest.routes['/'].cacheControl === 'no-store';
  const baselines = {
    magazines: Number(reader.get('SELECT COUNT(*) AS count FROM magazines').count),
    pageVariants: Number(reader.get('SELECT COUNT(*) AS count FROM pages').count),
    works: Number(reader.get('SELECT COUNT(*) AS count FROM published_works').count),
    contributors: Number(reader.get('SELECT COUNT(*) AS count FROM public_contributors').count),
    recitations: Number(reader.get('SELECT COUNT(*) AS count FROM audio_recitations').count),
    inlineMediaContributions: Number(reader.get('SELECT COUNT(*) AS count FROM published_work_media').count),
  };
  Object.entries(baselines).forEach(([key, value]) => {
    assert(manifest.summary[key] === value, `${key} baseline mismatch`);
  });
  assert(baselines.magazines === 47, 'reviewed magazine baseline changed');
  assert(baselines.pageVariants === 1824, 'reviewed page baseline changed');
  assert(baselines.works === 589, 'reviewed work baseline changed');
  assert(baselines.contributors === 130, 'reviewed contributor baseline changed');
  assert(baselines.recitations === 218, 'reviewed recitation baseline changed');
  assert(baselines.inlineMediaContributions === 15, 'reviewed media baseline changed');
  assert(
    Number(reader.get(
      'SELECT COUNT(*) AS count FROM public_media_metadata',
    ).count) === 709,
    'reviewed technical-media baseline changed',
  );

  reader.all(`
    SELECT magazineIndex, pageNumber FROM pages
    ORDER BY magazineIndex, pageNumber
  `).forEach((page) => {
    const route = `/dergiler/sayi${Number(page.magazineIndex)}/${Number(page.pageNumber)}`;
    assert(manifest.routes[route], `missing generated page ${route}`);
  });
  let audioPlayerGroups = 0;
  let audioPlayerTracks = 0;
  let legacyOnlyAudioTracks = 0;
  const genericTeamTracks = [];
  reader.all('SELECT id FROM magazines ORDER BY id').forEach((magazine) => {
    const issue = Number(magazine.id);
    assert(manifest.routes[`/dergiler/sayi${issue}`], `missing issue ${issue}`);
    assert(manifest.routes[`/magazines/${issue}/pages`], `missing issue JSON ${issue}`);
    const payload = JSON.parse(readRoute(`/magazines/${issue}/pages`));
    Object.entries(payload.pages).forEach(([pageNumber, html]) => {
      assert(
        !/<i\b[^>]*class=(?:"[^"]*\b(?:fas|fab)\b[^"]*"|'[^']*\b(?:fas|fab)\b[^']*')/i.test(html),
        `issue ${issue} page ${pageNumber} retains Font Awesome markup`,
      );
      assert(!/fa-certificate2/.test(html), `issue ${issue} page ${pageNumber} retains malformed icon markup`);
    });
    Object.entries(payload.audioPlayers || {}).forEach(([pageNumber, players]) => {
      audioPlayerGroups += players.length;
      players.forEach((player) => {
        audioPlayerTracks += player.tracks.length;
        legacyOnlyAudioTracks += player.tracks.filter((track) => !track.recitationId).length;
        player.tracks.forEach((track) => {
          assert(track.sources.length === 1, `${track.id} must expose one audio source`);
          assert(track.sources[0].type === 'audio/mpeg', `${track.id} must expose MP3 audio`);
          assert(!/\.ogg(?:$|[?#])/i.test(track.sources[0].src), `${track.id} exposes OGG audio`);
          if (track.reader === 'Galata Dergisi Ses Makinesi Ekibi') {
            assert(track.reciterLinks.length === 0, `${track.id} links the generic team credit`);
            genericTeamTracks.push(`${issue}:${Number(pageNumber)}:${track.title}`);
          }
        });
      });
      assert(
        !/player_songs|\binitPlayer\s*\(|\bstartPlayer\s*\(|\son(?:click|mousedown|mousemove|mouseout)=|<audio\b/i
          .test(payload.pages[pageNumber]),
        `issue ${issue} page ${pageNumber} retains legacy audio runtime markup`,
      );
      ['audio-previous', 'audio-next', 'audio-play', 'audio-volume-high']
        .forEach((name) => {
          assert(
            payload.pages[pageNumber].includes(
              `<use href="#${iconLibrary.symbolId(name)}"`,
            ),
            `issue ${issue} page ${pageNumber} is missing ${name}`,
          );
        });
      assert(
        !/legacy-player-icons/.test(payload.pages[pageNumber]),
        `issue ${issue} page ${pageNumber} retains a legacy control icon`,
      );
    });
  });
  assert(audioPlayerGroups === 45, 'audio-player group baseline mismatch');
  assert(audioPlayerTracks === 237, 'audio-player track baseline mismatch');
  assert(legacyOnlyAudioTracks === 19, 'legacy-only audio baseline mismatch');
  nodeAssert.deepEqual(genericTeamTracks, [
    '34:27:Sahte Pelerin',
    '34:27:Bir Fasit Daire',
    '42:43:“Sarı Kağıtlar ve Hatıralar” Şiir Dinletisi',
    '45:34:“Kapı” Şiir Dinletisi',
    '46:58:“Geçtiğimiz Altı Ayda Çok Şey Oldu” Şiir Dinletisi',
  ], 'generic team player-credit corpus mismatch');
  reader.all('SELECT id, slug FROM public_contributors ORDER BY id')
    .forEach((contributor) => {
      const route = `/katkida-bulunanlar/${Number(contributor.id)}-${contributor.slug}`;
      assert(manifest.routes[route], `missing contributor ${route}`);
      assert(
        manifest.contributorSlugs[String(contributor.id)] === contributor.slug,
        `contributor slug mismatch for ${contributor.id}`,
      );
    });

  [
    '/', '/magazines', '/feed.xml', '/sitemap.xml', '/robots.txt',
    '/bundle.js', '/bundle.css',
  ].forEach((route) => assert(manifest.routes[route], `missing route ${route}`));

  const homepage = readRoute('/');
  Object.entries(manifest.routes)
    .filter(([, entry]) => entry.contentType.startsWith('text/html'))
    .forEach(([route]) => {
      assert(
        !/googletag|google-analytics|fonts\.googleapis/i.test(readRoute(route)),
        `${route} contains removed Google analytics or font requests`,
      );
    });
  const bootstrapMarker = '<script id="galata-bootstrap" type="application/json">';
  const bootstrapStart = homepage.indexOf(bootstrapMarker);
  assert(bootstrapStart !== -1, 'homepage bootstrap data missing');
  const homepageApp = homepage.slice(homepage.indexOf('<div id="app">'), bootstrapStart);
  const iconSymbols = homepageApp.match(/<symbol id="galata-icon-[^"]+"/g) || [];
  assert(iconSymbols.length === 0, 'homepage must defer the reader icon sprite');
  assert(!/font-awesome|fontawesome|Material\+Icons/i.test(homepage), 'homepage retains an external icon library');
  const readerHtml = readRoute('/dergiler/sayi1/1');
  assert(
    (readerHtml.match(/<symbol id="galata-icon-[^"]+"/g) || []).length
      === Object.keys(iconLibrary.icons).length,
    'reader inline icon sprite must contain every symbol',
  );
  iconLibrary.toolbarIconNames.forEach((name) => {
    assert(
      readerHtml.includes(`<use href="#${iconLibrary.symbolId(name)}"`),
      `reader toolbar is missing ${name}`,
    );
  });
  const renderedThumbnailCount = (
    homepageApp.match(
      /<img[^>]+src="\/images\/sayi\d+\/thumbnail\.jpg"[^>]+width="100"[^>]+height="140"/g,
    ) || []
  ).length;
  const renderedMagazineLinkCount = (
    homepageApp.match(/href="\/dergiler\/sayi\d+"/g) || []
  ).length;
  const bootstrapEnd = homepage.indexOf('</script>', bootstrapStart);
  assert(bootstrapEnd !== -1, 'homepage bootstrap script is incomplete');
  const bootstrap = JSON.parse(homepage.slice(
    bootstrapStart + bootstrapMarker.length,
    bootstrapEnd,
  ));
  assert(
    renderedThumbnailCount === 4 && renderedMagazineLinkCount === 4,
    'homepage must render only the latest and three visible carousel thumbnails',
  );
  assert(
    bootstrap.initialMagazines.length === baselines.magazines,
    'homepage bootstrap must retain every magazine',
  );

  Object.entries(manifest.routes).forEach(([route, entry]) => {
    const content = readEntry(entry);
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    assert(entry.etag === `"${digest}"`, `ETag mismatch for ${route}`);
    if (entry.gzipFile) {
      assert(
        zlib.gunzipSync(readEntry(entry, true)).equals(content),
        `gzip mismatch for ${route}`,
      );
    }
  });

  shellAssetEntries.forEach(([logicalPath]) => {
    const route = manifest.routes[logicalPath];
    assert(route, `missing shell asset route ${logicalPath}`);
    const content = readEntry(route);
    const expected = shellAssetManifest.assets[logicalPath];
    const actualDigest = crypto.createHash('sha256').update(content).digest('hex');
    assert(actualDigest === expected.digest, `${logicalPath} shell digest mismatch`);
    assert(
      expected.url === logicalPath || expected.url.startsWith(`${logicalPath}?v=`),
      `${logicalPath} shell URL mismatch`,
    );
  });

  const serviceWorker = readRoute('/service-worker.js');
  Object.values(shellAssetManifest.groups).flat().forEach((url) => {
    assert(
      serviceWorker.includes(JSON.stringify(url)),
      `service worker does not contain grouped asset ${url}`,
    );
  });
  for (const logicalPath of [
    '/images/first-shelf.png',
    '/images/header-logo.jpg',
    '/images/wall-bookshelf.png',
  ]) {
    assert(
      !shellAssetManifest.groups.homepage.includes(shellAssetManifest.assets[logicalPath].url),
      `homepage install must exclude fallback image ${logicalPath}`,
    );
  }

  if (!development) {
    Object.entries(manifest.routes)
      .filter(([, entry]) => entry.contentType.startsWith('text/html'))
      .forEach(([route]) => {
        const html = readRoute(route);
        assert(
          applyShellAssetVersions(html, shellAssetManifest) === html,
          `${route} contains an unversioned or stale shell reference`,
        );
      });

    for (const logicalPath of [
      '/images/favicon.png',
      '/images/carousel-thumbnail-placeholders.webp',
      '/images/header-logo.svg',
      '/global.css',
      '/bundle.css',
      '/bundle.js',
    ]) {
      assert(
        readRoute('/').includes(shellAssetManifest.assets[logicalPath].url),
        `homepage does not reference ${logicalPath} with its current version`,
      );
    }
    assert(!readRoute('/').includes('/legacy-player.js'), 'homepage retains legacy player script');

    assert(
      manifest.routes['/images/carousel-thumbnail-placeholders.webp'].contentType
        === 'image/webp',
      'carousel placeholder sprite must be served as image/webp',
    );
  }

  const indexableRoutes = Object.keys(manifest.routes).filter((route) => (
    route === '/'
    || /^\/dergiler\/sayi\d+(?:\/\d+)?$/.test(route)
    || /^\/katkida-bulunanlar\/\d+-[^/]+$/.test(route)
  ));
  assert(indexableRoutes.length === 2002, 'indexable HTML baseline changed');

  const canonicalSeo = new Map();
  const canonicalGraphs = new Map();
  indexableRoutes.forEach((route) => {
    const html = readRoute(route);
    const signature = seoSignature(html, route);
    assert(signature.description.trim(), `${route} description is empty`);
    assert(
      !/dateModified|article:modified_time/.test(html),
      `${route} exposes an unverified modification date`,
    );
    assert(
      html.includes('<meta name="twitter:site" content="@GalataDergisi" />'),
      `${route} Twitter site identity missing`,
    );
    assert(
      html.includes(`rel="alternate" type="application/atom+xml" title="Galata Dergisi" href="${expectedBaseUrl}/feed.xml"`),
      `${route} Atom discovery missing`,
    );
    assert(!/twitter:creator|hreflang=/.test(html), `${route} publishes unreviewed identity metadata`);
    if (route.startsWith('/dergiler/')) {
      assert(!/name="viewport"/.test(html), `${route} reader viewport changed`);
      assert(html.includes('id="galata-bootstrap"'), `${route} bootstrap missing`);
      assert(html.includes('class="magazine '), `${route} SSR content missing`);
    }
    if (canonicalSeo.has(signature.canonical)) {
      assert(
        canonicalSeo.get(signature.canonical) === signature.value,
        `${route} conflicts with canonical cluster ${signature.canonical}`,
      );
    } else {
      canonicalSeo.set(signature.canonical, signature.value);
      canonicalGraphs.set(
        signature.canonical,
        structuredData(html, route),
      );
    }
  });
  assert(canonicalSeo.size === 724, 'canonical identity baseline changed');

  const homeSeoDocument = seoDocument(readRoute('/'), '/');
  let generatedSeoDocuments = 0;
  const endpointSeoDocuments = new Map();
  reader.all('SELECT id FROM magazines ORDER BY id').forEach((magazine) => {
    const issue = Number(magazine.id);
    const route = `/magazines/${issue}/seo`;
    const payload = JSON.parse(readRoute(route));
    assert(payload.success === true, `${route} success mismatch`);
    assert(payload.version === 1, `${route} version mismatch`);
    assert(payload.issue === issue, `${route} issue mismatch`);
    nodeAssert.deepStrictEqual(payload.home, homeSeoDocument, `${route} homepage SEO mismatch`);
    nodeAssert.deepStrictEqual(
      manifest.routes[`${route}/`],
      manifest.routes[route],
      `${route} alias mismatch`,
    );

    const pages = reader.all(`
      SELECT pageNumber FROM pages WHERE magazineIndex = ? ORDER BY pageNumber
    `, issue);
    assert(Object.keys(payload.pages).length === pages.length, `${route} page map mismatch`);
    pages.forEach(({ pageNumber }) => {
      const page = Number(pageNumber);
      const physicalRoute = `/dergiler/sayi${issue}/${page}`;
      const mapping = payload.pages[String(page)];
      assert(mapping, `${route} page ${page} mapping missing`);
      assert(
        mapping.route === (page === 1 ? `/dergiler/sayi${issue}` : physicalRoute),
        `${route} page ${page} preferred route mismatch`,
      );
      assert(payload.documents[mapping.document], `${route} page ${page} document missing`);
      nodeAssert.deepStrictEqual(
        payload.documents[mapping.document],
        seoDocument(readRoute(physicalRoute), physicalRoute),
        `${route} page ${page} SEO differs from its server document`,
      );
    });
    Object.entries(payload.documents).forEach(([pathname, document_]) => {
      endpointSeoDocuments.set(pathname, document_);
    });
    generatedSeoDocuments += Object.keys(payload.documents).length;
  });
  assert(generatedSeoDocuments === 593, 'generated issue/work SEO document count mismatch');

  const graphNodes = new Map();
  canonicalGraphs.forEach((document, canonical) => {
    assert(document['@context'] === 'https://schema.org', `${canonical} context mismatch`);
    assert(Array.isArray(document['@graph']), `${canonical} graph missing`);
    document['@graph'].forEach((node) => {
      if (node && node['@id'] && !graphNodes.has(node['@id'])) {
        graphNodes.set(node['@id'], node);
      }
    });
  });

  const issues = [...graphNodes.values()].filter(
    (node) => node['@type'] === 'PublicationIssue',
  );
  const profiles = [...graphNodes.values()].filter(
    (node) => node['@type'] === 'ProfilePage',
  );
  const audio = [...graphNodes.values()].filter(
    (node) => node['@type'] === 'AudioObject',
  );
  const videos = [...graphNodes.values()].filter(
    (node) => node['@type'] === 'VideoObject',
  );
  assert(issues.length === 47, 'structured issue count mismatch');
  assert(profiles.length === 130, 'structured profile count mismatch');
  assert(audio.length === 218, 'structured recitation count mismatch');
  assert(videos.length === 8, 'structured video count mismatch');
  audio.forEach((node) => {
    assert(node.encoding.length === 1, `${node['@id']} encoding count mismatch`);
    node.encoding.forEach((encoding) => {
      assert(encoding.contentUrl, `${node['@id']} encoding URL missing`);
      assert(encoding.encodingFormat === 'audio/mpeg', `${node['@id']} encoding format mismatch`);
      assert(encoding.contentSize, `${node['@id']} encoding size missing`);
      assert(!/\.ogg(?:$|[?#])/i.test(encoding.contentUrl), `${node['@id']} exposes OGG audio`);
    });
  });
  videos.forEach((node) => {
    [
      'contentUrl', 'thumbnailUrl', 'uploadDate', 'duration',
      'width', 'height', 'encodingFormat', 'contentSize',
    ].forEach((property) => {
      assert(node[property], `${node['@id']} ${property} missing`);
    });
  });

  reader.all(`
    SELECT magazineIndex, startPage, kind
    FROM published_works ORDER BY id
  `).forEach((work) => {
    const pathname = work.kind === 'issue-cover'
      ? `/dergiler/sayi${Number(work.magazineIndex)}`
      : `/dergiler/sayi${Number(work.magazineIndex)}/${Number(work.startPage)}`;
    const id = `${new URL(pathname, `${expectedBaseUrl}/`)}#work`;
    assert(graphNodes.has(id), `structured work missing: ${id}`);
  });
  reader.all(`
    SELECT r.pageNumber, r.anchorId, w.magazineIndex
    FROM audio_recitations r
    INNER JOIN published_works w ON w.id = r.workId
    ORDER BY r.id
  `).forEach((recitation) => {
    const id = `${new URL(
      `/dergiler/sayi${Number(recitation.magazineIndex)}/${Number(recitation.pageNumber)}`,
      `${expectedBaseUrl}/`,
    )}#${recitation.anchorId}`;
    assert(graphNodes.has(id), `structured recitation missing: ${id}`);
  });
  reader.all(`
    SELECT m.pageNumber, m.anchorId, w.magazineIndex
    FROM published_work_media m
    INNER JOIN published_works w ON w.id = m.workId
    WHERE m.kind = 'video'
    ORDER BY m.id
  `).forEach((video) => {
    const id = `${new URL(
      `/dergiler/sayi${Number(video.magazineIndex)}/${Number(video.pageNumber)}`,
      `${expectedBaseUrl}/`,
    )}#${video.anchorId}`;
    assert(graphNodes.has(id), `structured video missing: ${id}`);
  });

  const issueOne = graphNodes.get(`${expectedBaseUrl}/dergiler/sayi1#issue`);
  const issueSix = graphNodes.get(`${expectedBaseUrl}/dergiler/sayi6#issue`);
  const issueEighteen = graphNodes.get(`${expectedBaseUrl}/dergiler/sayi18#issue`);
  const issueNineteen = graphNodes.get(`${expectedBaseUrl}/dergiler/sayi19#issue`);
  const issueTwentySix = graphNodes.get(`${expectedBaseUrl}/dergiler/sayi26#issue`);
  const issueThirtySeven = graphNodes.get(`${expectedBaseUrl}/dergiler/sayi37#issue`);
  const issueFortySeven = graphNodes.get(`${expectedBaseUrl}/dergiler/sayi47#issue`);
  assert(issueOne.datePublished === '2014-05-31T21:00:00.000Z', 'issue 1 date mismatch');
  assert(issueSix.datePublished === '2014-10-31T22:00:00.000Z', 'issue 6 date mismatch');
  assert(issueEighteen.datePublished === '2015-10-31T21:00:00.000Z', 'issue 18 date mismatch');
  assert(issueNineteen.datePublished === '2015-11-30T22:00:00.000Z', 'issue 19 date mismatch');
  assert(issueTwentySix.datePublished === '2016-09-30T21:00:00.000Z', 'issue 26 date mismatch');
  assert(issueThirtySeven.datePublished === '2020-05-31T21:00:00.000Z', 'issue 37 date mismatch');
  assert(issueFortySeven.datePublished === '2022-02-28T21:00:00.000Z', 'issue 47 date mismatch');

  const sitemap = readRoute('/sitemap.xml');
  assert(sitemap.includes(`${expectedBaseUrl}/dergiler/sayi47`), 'sitemap issue missing');
  assert(sitemap.includes(`${expectedBaseUrl}/katkida-bulunanlar/`), 'sitemap contributor missing');
  assert(
    sitemap.includes('<lastmod>2022-02-28T21:00:00.000Z</lastmod>'),
    'sitemap latest content-change date missing',
  );
  assert(!sitemap.includes('/feed.xml'), 'Atom feed must stay outside the sitemap');

  const feed = readRoute('/feed.xml');
  assert(
    manifest.routes['/feed.xml'].contentType === 'application/atom+xml; charset=utf-8',
    'Atom content type mismatch',
  );
  assert(feed.includes('<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="tr">'), 'Atom root mismatch');
  assert(feed.includes('<title>Galata Dergisi</title>'), 'Atom title mismatch');
  assert(feed.includes('<subtitle>Tek, düzeleşmeyen dergi.</subtitle>'), 'Atom subtitle mismatch');
  assert(feed.includes('<author>\n    <name>Galata Dergisi</name>\n  </author>'), 'Atom site author mismatch');
  assert(feed.includes(`<link rel="self" type="application/atom+xml" href="${expectedBaseUrl}/feed.xml" />`), 'Atom self link mismatch');
  const feedEntries = parseAtomEntries(feed);
  assert(feedEntries.length === 546, 'Atom canonical work count mismatch');
  assert(new Set(feedEntries.map((entry) => entry.id)).size === feedEntries.length, 'Atom entry IDs must be unique');
  assert(
    feed.includes('<updated>2022-02-28T21:00:00.000Z</updated>'),
    'Atom newest publication date missing',
  );

  const workAuthors = new Map();
  reader.all(`
    SELECT relationship.workId, contributor.displayName
    FROM published_work_contributors relationship
    INNER JOIN public_contributors contributor
      ON contributor.id = relationship.contributorId
    ORDER BY relationship.workId, relationship.position, relationship.contributorId
  `).forEach((row) => {
    const workId = Number(row.workId);
    if (!workAuthors.has(workId)) workAuthors.set(workId, []);
    workAuthors.get(workId).push(row.displayName);
  });
  const expectedFeedEntries = reader.all(`
    SELECT
      work.id, work.magazineIndex, work.startPage, work.title, work.type,
      magazine.publishDate
    FROM published_works work
    INNER JOIN magazines magazine ON magazine.id = work.magazineIndex
    WHERE work.kind <> 'issue-cover'
    ORDER BY magazine.publishDate DESC, work.magazineIndex DESC, work.startPage ASC
  `).map((work) => {
    const pathname = `/dergiler/sayi${Number(work.magazineIndex)}/${Number(work.startPage)}`;
    const canonical = `${expectedBaseUrl}${pathname}`;
    const seo = endpointSeoDocuments.get(pathname);
    assert(seo, `Atom source SEO missing: ${pathname}`);
    const published = new Date(work.publishDate).toISOString();
    return {
      title: work.title,
      id: canonical,
      alternate: canonical,
      published,
      updated: published,
      authors: workAuthors.get(Number(work.id)) || [],
      category: work.type,
      summary: seo.description,
    };
  });
  nodeAssert.deepStrictEqual(
    feedEntries,
    expectedFeedEntries,
    'Atom entries differ from reviewed canonical work metadata',
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    release: manifest.release,
    summary: manifest.summary,
  }, null, 2)}\n`);
} finally {
  reader.close();
}
