// Copyright 2026 Mehmet Baker
//
// Renders crawlable HTML and metadata while keeping the existing Svelte reader
// as the progressively enhanced browser experience.

const fs = require('fs');
const path = require('path');
const {
  createDescription,
  escapeAttribute,
  escapeHtml,
  extractPrimaryImagePath,
  safeJson,
  splitContributorNames,
  stripHtml,
} = require('./seo-utils.js');
const StructuredDataBuilder = require('./seo-structured-data.js');
const { RIGHTS_PATH } = StructuredDataBuilder;
const { renderMarkdownPage } = require('./static-markdown-page.js');
const {
  applyShellAssetVersions,
  versionShellAssetPath,
} = require('./shell-assets.js');

const FEED_TITLE = 'Galata Dergisi';
const TWITTER_SITE = '@GalataDergisi';
const HOMEPAGE_CAROUSEL_PRELOAD_MARKER =
  '<!-- homepage-carousel-placeholder-preload -->';
const HOMEPAGE_CAROUSEL_PRELOAD =
  '<link rel="preload" as="image" type="image/webp" href="/images/carousel-thumbnail-placeholders.webp" />';
const FLAT_PROFILE_MAX_ROW_COUNT = 5;
const LONG_PROFILE_ROW_COUNT = 20;
const PROFILE_CONTRIBUTION_GROUPS = Object.freeze([
  Object.freeze({
    key: 'written', title: 'Yazılı Katkılar', navigationTitle: 'Yazılı', anchorId: 'yazili-katkilar',
  }),
  Object.freeze({
    key: 'visual', title: 'Görsel Katkılar', navigationTitle: 'Görsel', anchorId: 'gorsel-katkilar',
  }),
  Object.freeze({
    key: 'cover', title: 'Kapak Görselleri', navigationTitle: 'Kapak', anchorId: 'kapak-gorselleri',
  }),
  Object.freeze({
    key: 'recitation', title: 'Ses Makinesi', navigationTitle: 'Ses Makinesi', anchorId: 'ses-makinesi',
  }),
]);

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

function toIsoDate(value) {
  if (!value) return undefined;
  if (
    typeof value === 'string'
    && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
  ) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function absoluteUrl(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl.replace(/\/+$/, '')}/`).toString();
}

function recitationTitle(recitation) {
  return recitation.poemTitle || '(başlık yok)';
}

function storyNarrationSentence(recitation, contributorName) {
  if (recitation.kind !== 'story-narration') return '';
  const role = String(recitation.role || '').trim();
  if (contributorName === 'Funda Yaramış' && role === '***') {
    return ' adlı hikayede yorumcu dış sesi seslendirdi.';
  }
  if (role.toLocaleLowerCase('tr-TR').includes('anlatıcı')) {
    return ' adlı hikayede anlatıcıyı seslendirdi.';
  }
  return ` adlı hikayede ${role} karakterini seslendirdi.`;
}

function contributorPath(contributor) {
  return `/katkida-bulunanlar/${Number(contributor.id)}-${contributor.slug}`;
}

function workPath(work) {
  if (work.kind === 'issue-cover') {
    return `/dergiler/sayi${Number(work.magazineIndex)}`;
  }
  return `/dergiler/sayi${Number(work.magazineIndex)}/${Number(work.startPage)}`;
}

function mediaContributionPath(media) {
  return `/dergiler/sayi${Number(media.magazineIndex)}/${Number(media.pageNumber)}#${media.anchorId}`;
}

function mediaKindLabel(kind) {
  return {
    drawing: 'Çizim',
    illustration: 'İllüstrasyon',
    photograph: 'Fotoğraf',
    video: 'Video',
    visual: 'Görsel',
  }[kind] || 'Görsel';
}

function workKindLabel(work) {
  if (work.kind === 'issue-cover') return 'Kapak Görseli';
  if (work.type === 'poetry') return 'Şiir';
  if (work.type === 'prose' || work.type === 'creative-work') return 'Düzyazı';
  if (work.type === 'visual') return 'Görsel';
  return 'Katkı';
}

function profileContributionLabel(contribution) {
  return contribution.contributionType === 'media'
    ? mediaKindLabel(contribution.kind)
    : workKindLabel(contribution);
}

function profileContributionGroup(contribution) {
  if (contribution.contributionType === 'recitation') return 'recitation';
  if (contribution.contributionType === 'media') return 'visual';
  if (contribution.kind === 'issue-cover') return 'cover';
  if (contribution.type === 'visual') return 'visual';
  return 'written';
}

function compareProfileContributions(left, right) {
  const leftTime = new Date(left.publishDate).getTime();
  const rightTime = new Date(right.publishDate).getTime();
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    const timeDifference = rightTime - leftTime;
    if (timeDifference) return timeDifference;
  }
  return Number(right.magazineIndex) - Number(left.magazineIndex)
    || Number(left.sortPage) - Number(right.sortPage)
    || (Number(left.sequence) || Number(left.id) || 0)
      - (Number(right.sequence) || Number(right.id) || 0);
}

function createProfileViewModel(profile) {
  const works = profile.works || [];
  const recitations = (profile.recitations || []).map((recitation) => ({
    ...recitation,
    contributionType: 'recitation',
    sortPage: recitation.pageNumber,
  })).sort(compareProfileContributions);
  const mediaContributions = profile.mediaContributions || [];
  const workContributions = [
    ...works.map((work) => ({
      ...work,
      contributionType: 'work',
      sortPage: work.startPage,
    })),
    ...mediaContributions.map((media) => ({
      ...media,
      contributionType: 'media',
      sortPage: media.pageNumber,
    })),
  ].sort(compareProfileContributions);
  const allContributions = [
    ...workContributions,
    ...recitations,
  ].sort(compareProfileContributions);
  const groupedContributions = Object.fromEntries(
    PROFILE_CONTRIBUTION_GROUPS.map(({ key }) => [
      key,
      allContributions.filter((contribution) => (
        profileContributionGroup(contribution) === key
      )),
    ]),
  );
  const writtenCount = groupedContributions.written.length;
  const visualCount = groupedContributions.visual.length;
  const coverCount = groupedContributions.cover.length;
  const summaryParts = [
    writtenCount ? `${writtenCount} yazılı katkı` : '',
    visualCount ? `${visualCount} görsel katkı` : '',
    coverCount ? `${coverCount} kapak görseli` : '',
    recitations.length ? `${recitations.length} sesli katkı` : '',
  ].filter(Boolean);
  const issueNumbers = [
    ...workContributions,
    ...recitations,
  ].map((item) => Number(item.magazineIndex))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const firstIssue = issueNumbers[0];
  const lastIssue = issueNumbers.at(-1);
  const issueRange = firstIssue === lastIssue
    ? `Sayı ${firstIssue}`
    : `Sayı ${firstIssue}–${lastIssue}`;
  const issueRangeLabel = firstIssue === lastIssue
    ? issueRange
    : `Sayı ${firstIssue} – Sayı ${lastIssue}`;

  return {
    allContributions,
    groupedContributions,
    issueRange,
    issueRangeLabel,
    mediaContributions,
    recitations,
    summary: summaryParts.join(' · '),
    totalRows: allContributions.length,
    workContributions,
  };
}

function renderProfileContributionMeta(label, contribution) {
  const issueNumber = Number(contribution.magazineIndex);
  const issuePath = `/dergiler/sayi${issueNumber}`;
  const publishDate = contribution.publishDateText ? `
              <span aria-hidden="true">·</span>
              <span>${escapeHtml(contribution.publishDateText)}</span>` : '';
  return `
            <span class="contribution-meta">
              <span class="contribution-type">${escapeHtml(label)}</span>
              <a class="contribution-issue" href="${escapeAttribute(issuePath)}">Sayı ${issueNumber}</a>${publishDate}
            </span>`;
}

function profileRowId(anchorId) {
  return anchorId ? ` id="${escapeAttribute(anchorId)}"` : '';
}

function renderProfileWorkRow(contribution, anchorId = '') {
  const href = contribution.contributionType === 'media'
    ? mediaContributionPath(contribution)
    : workPath(contribution);
  const titleLink = `<a class="contribution-link" href="${escapeAttribute(
    href,
  )}">${escapeHtml(contribution.title)}</a>`;
  return `
          <li class="contribution-row"${profileRowId(anchorId)}>
            ${titleLink}${renderProfileContributionMeta(
    profileContributionLabel(contribution),
    contribution,
  )}
          </li>`;
}

function renderProfileRecitationRow(recitation, contributorName, anchorId = '') {
  const title = recitationTitle(recitation);
  const narrationSentence = storyNarrationSentence(recitation, contributorName);
  const label = narrationSentence || !recitation.poetName
    ? title
    : `${title} — ${recitation.poetName}`;
  const href = `/dergiler/sayi${Number(recitation.magazineIndex)}/${Number(
    recitation.pageNumber,
  )}#${recitation.anchorId}`;
  return `
          <li class="contribution-row"${profileRowId(anchorId)}>
            <a class="contribution-link" href="${escapeAttribute(href)}">${escapeHtml(label)}</a>${narrationSentence ? `
            <span class="contribution-note">${escapeHtml(narrationSentence.trim())}</span>` : ''}${renderProfileContributionMeta(
    'Ses',
    recitation,
  )}
          </li>`;
}

function renderProfileContributionRow(contribution, contributorName, anchorId = '') {
  return contribution.contributionType === 'recitation'
    ? renderProfileRecitationRow(contribution, contributorName, anchorId)
    : renderProfileWorkRow(contribution, anchorId);
}

function imageContentType(value) {
  const pathname = (() => {
    try {
      return new URL(String(value || ''), 'https://galatadergisi.org').pathname;
    } catch (error) {
      return String(value || '').split(/[?#]/, 1)[0];
    }
  })();
  const extension = pathname.toLocaleLowerCase('en-US').match(/\.([a-z0-9]+)$/);
  return {
    avif: 'image/avif',
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    webp: 'image/webp',
  }[extension ? extension[1] : ''];
}

function readJpegDimensions(content) {
  if (
    content.length < 4
    || content[0] !== 0xff
    || content[1] !== 0xd8
  ) {
    return null;
  }

  let offset = 2;
  while (offset + 8 < content.length) {
    if (content[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < content.length && content[offset] === 0xff) offset += 1;
    if (offset >= content.length) break;
    const marker = content[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda || offset + 1 >= content.length) break;

    const segmentLength = content.readUInt16BE(offset);
    if (
      JPEG_START_OF_FRAME_MARKERS.has(marker)
      && segmentLength >= 7
      && offset + segmentLength <= content.length
    ) {
      return {
        height: content.readUInt16BE(offset + 3),
        width: content.readUInt16BE(offset + 5),
      };
    }
    if (segmentLength < 2) break;
    offset += segmentLength;
  }
  return null;
}

function readImageDimensions(filename, contentType) {
  try {
    const content = fs.readFileSync(filename);
    if (
      contentType === 'image/png'
      && content.length >= 24
      && content.subarray(0, 8).equals(Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]))
    ) {
      return {
        width: content.readUInt32BE(16),
        height: content.readUInt32BE(20),
      };
    }
    if (contentType === 'image/jpeg') return readJpegDimensions(content);
  } catch (error) {
    return null;
  }
  return null;
}

function conciseNames(values, maximum = 3) {
  const names = [...new Set(values.filter(Boolean))];
  if (names.length <= maximum) return names.join(', ');
  return `${names.slice(0, maximum).join(', ')} ve diğerleri`;
}

function workTypeLabel(work) {
  return {
    poetry: 'şiir',
    prose: 'yazı',
    audio: 'ses çalışması',
    visual: mediaKindLabel(work.kind).toLocaleLowerCase('tr-TR'),
    'creative-work': 'eser',
  }[work.type] || 'eser';
}

function workFallbackDescription(issue, work) {
  const creators = work.contributors.map(
    (contributor) => contributor.displayName,
  );
  if (work.type === 'audio') {
    const poets = conciseNames(
      work.recitations.flatMap((recitation) => (
        splitContributorNames(recitation.poetName)
      )),
    );
    const performers = conciseNames(
      work.recitations.flatMap((recitation) => (
        recitation.contributors.map((contributor) => contributor.displayName)
      )),
    );
    return [
      `Galata Dergisi Sayı ${issue.index}, ${issue.publishDateText} Ses Makinesi:`,
      `${work.recitations.length} ses kaydı.`,
      poets ? `Eserler: ${poets}.` : '',
      performers ? `Yorumlayanlar: ${performers}.` : '',
    ].filter(Boolean).join(' ');
  }
  if (work.type === 'visual') {
    return [
      `${work.title},`,
      creators.length ? `${creators.join(', ')} imzalı` : '',
      `${workTypeLabel(work)} — Galata Dergisi Sayı ${issue.index},`,
      `${issue.publishDateText}.`,
    ].filter(Boolean).join(' ').replace(/\s+,/g, ',');
  }
  return [
    `${work.title},`,
    creators.length ? `${creators.join(', ')} tarafından` : '',
    `Galata Dergisi Sayı ${issue.index}, ${issue.publishDateText} içinde`,
    `yayımlanan ${workTypeLabel(work)}.`,
  ].filter(Boolean).join(' ').replace(/\s+,/g, ',');
}

function meaningfulWordCount(html, excludedValues) {
  let text = stripHtml(html);
  excludedValues.filter(Boolean).forEach((value) => {
    const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped, 'giu'), ' ');
  });
  return (text.match(/[\p{L}\p{N}]+/gu) || []).length;
}

function renderFallback(props) {
  if (props.initialMagazineIndex && props.initialPages) {
    const startPage = Number(props.initialWorkStartPage || props.initialLandingPage || 1);
    const endPage = Number(props.initialWorkEndPage || startPage);
    const content = [];
    for (let page = startPage; page <= endPage; page += 1) {
      if (props.initialPages[page]) content.push(props.initialPages[page]);
    }
    return `<main class="server-rendered-work">${content.join('\n')}</main>`;
  }

  const items = (props.initialMagazines || []).map((magazine) => `
    <li>
      <a href="/dergiler/sayi${Number(magazine.index)}">
        <img
          src="${escapeAttribute(magazine.thumbnailURL)}"
          alt="Sayı ${Number(magazine.index)}, ${escapeAttribute(magazine.publishDateText)}" />
        <span>Sayı ${Number(magazine.index)}, ${escapeHtml(magazine.publishDateText)}</span>
      </a>
    </li>`).join('');
  return `<main class="server-rendered-home"><h1>Galata Dergisi</h1><ul>${items}</ul></main>`;
}

function clonePageProps(props) {
  return {
    ...props,
    initialMagazines: (props.initialMagazines || [])
      .map((magazine) => ({ ...magazine })),
    initialPages: props.initialPages ? { ...props.initialPages } : null,
    initialAudioPlayers: props.initialAudioPlayers
      ? Object.fromEntries(
        Object.entries(props.initialAudioPlayers).map(([page, players]) => [
          page,
          players.map((player) => ({
            ...player,
            tracks: player.tracks.map((track) => ({
              ...track,
              reciterLinks: track.reciterLinks.map((link) => ({ ...link })),
              sources: track.sources.map((source) => ({ ...source })),
            })),
          })),
        ]),
      )
      : null,
  };
}

class SeoRenderer {
  constructor(params) {
    this.templatePath = params.templatePath;
    this.ssrBundlePath = params.ssrBundlePath;
    this.baseUrl = (params.baseUrl || 'https://galatadergisi.org').replace(/\/+$/, '');
    this.publicRoot = params.publicRoot ? fs.realpathSync(params.publicRoot) : null;
    this.mediaMetadata = params.mediaMetadata || new Map();
    this.assetManifest = params.assetManifest || null;
    this.homepageArtwork = params.homepageArtwork || {};
    this.rightsPagePath = params.rightsPagePath || path.resolve(
      __dirname,
      '../../content/pages/telif-ve-kullanim.md',
    );
    this.structuredData = new StructuredDataBuilder(
      this.baseUrl,
      this.mediaMetadata,
    );
    this.templateCache = null;
    this.rendererCache = null;
  }

  getTemplate() {
    const modifiedAt = fs.statSync(this.templatePath).mtimeMs;
    if (!this.templateCache || this.templateCache.modifiedAt !== modifiedAt) {
      this.templateCache = {
        modifiedAt,
        content: fs.readFileSync(this.templatePath, 'utf8'),
      };
    }
    return this.templateCache.content;
  }

  getSsrRenderer() {
    try {
      if (!fs.existsSync(this.ssrBundlePath)) return null;
      const modifiedAt = fs.statSync(this.ssrBundlePath).mtimeMs;
      if (this.rendererCache && this.rendererCache.modifiedAt === modifiedAt) {
        return this.rendererCache.component;
      }
      const resolvedPath = require.resolve(this.ssrBundlePath);
      delete require.cache[resolvedPath];
      // The generated path is fixed by the local Vite build orchestrator.
      const loaded = require(resolvedPath);
      const component = loaded.default || loaded;
      const renderer = component && typeof component.render === 'function' ? component : null;
      this.rendererCache = {
        modifiedAt,
        component: renderer,
      };
      return renderer;
    } catch (error) {
      return null;
    }
  }

  renderApp(props) {
    const renderer = this.getSsrRenderer();
    if (!renderer) {
      return {
        html: renderFallback(props),
        hydratable: false,
      };
    }

    const result = renderer.render(props);
    return {
      html: result.html,
      hydratable: true,
    };
  }

  getImageMetadata(imagePath, imageAlt) {
    if (!imagePath) return null;
    const metadata = {
      url: absoluteUrl(this.baseUrl, imagePath),
      alt: imageAlt,
      type: imageContentType(imagePath),
    };
    const reviewed = this.mediaMetadata.get(imagePath);
    if (reviewed) {
      metadata.type = reviewed.encodingFormat;
      metadata.width = reviewed.width;
      metadata.height = reviewed.height;
    }
    if (
      this.publicRoot
      && String(imagePath).startsWith('/')
      && !String(imagePath).startsWith('//')
    ) {
      try {
        const pathname = decodeURIComponent(
          new URL(imagePath, `${this.baseUrl}/`).pathname,
        );
        const filename = path.resolve(this.publicRoot, `.${pathname}`);
        if (
          filename.startsWith(`${this.publicRoot}${path.sep}`)
          && fs.existsSync(filename)
        ) {
          Object.assign(
            metadata,
            readImageDimensions(filename, metadata.type) || {},
          );
        }
      } catch (error) {
        // A valid public URL can still be useful without local image dimensions.
      }
    }
    return metadata;
  }

  createSeoDocument(metadata) {
    const canonical = absoluteUrl(this.baseUrl, metadata.canonicalPath);
    const image = this.getImageMetadata(metadata.image, metadata.imageAlt);
    if (image && this.assetManifest) {
      image.url = absoluteUrl(
        this.baseUrl,
        versionShellAssetPath(metadata.image, this.assetManifest),
      );
    }
    const structuredData = this.assetManifest
      ? JSON.parse(applyShellAssetVersions(
        JSON.stringify(metadata.structuredData),
        this.assetManifest,
      ))
      : metadata.structuredData;
    return {
      title: metadata.title,
      description: metadata.description,
      language: 'tr',
      canonical,
      openGraph: {
        type: metadata.ogType || 'website',
        siteName: 'Galata Dergisi',
        locale: 'tr_TR',
        title: metadata.title,
        description: metadata.description,
        url: canonical,
        image,
      },
      twitter: {
        card: image ? 'summary_large_image' : 'summary',
        site: TWITTER_SITE,
        title: metadata.title,
        description: metadata.description,
        image: image ? {
          url: image.url,
          alt: image.alt,
        } : null,
      },
      article: metadata.ogType === 'article' ? {
        publishedTime: metadata.publishedTime || null,
        section: metadata.articleSection || null,
        authorUrls: metadata.authorUrls || [],
      } : null,
      structuredData,
    };
  }

  static renderSocialMetadata(document) {
    const image = document.openGraph.image;
    const tags = [
      `<meta property="og:type" content="${escapeAttribute(document.openGraph.type)}" />`,
      `<meta property="og:site_name" content="${escapeAttribute(document.openGraph.siteName)}" />`,
      `<meta property="og:locale" content="${escapeAttribute(document.openGraph.locale)}" />`,
      `<meta property="og:title" content="${escapeAttribute(document.openGraph.title)}" />`,
      `<meta property="og:description" content="${escapeAttribute(document.openGraph.description)}" />`,
      `<meta property="og:url" content="${escapeAttribute(document.openGraph.url)}" />`,
      image ? `<meta property="og:image" content="${escapeAttribute(image.url)}" />` : '',
      image && image.alt
        ? `<meta property="og:image:alt" content="${escapeAttribute(image.alt)}" />`
        : '',
      image && image.type
        ? `<meta property="og:image:type" content="${escapeAttribute(image.type)}" />`
        : '',
      image && image.width
        ? `<meta property="og:image:width" content="${Number(image.width)}" />`
        : '',
      image && image.height
        ? `<meta property="og:image:height" content="${Number(image.height)}" />`
        : '',
      `<meta name="twitter:card" content="${escapeAttribute(document.twitter.card)}" />`,
      `<meta name="twitter:site" content="${escapeAttribute(document.twitter.site)}" />`,
      `<meta name="twitter:title" content="${escapeAttribute(document.twitter.title)}" />`,
      `<meta name="twitter:description" content="${escapeAttribute(document.twitter.description)}" />`,
      document.twitter.image
        ? `<meta name="twitter:image" content="${escapeAttribute(document.twitter.image.url)}" />`
        : '',
      document.twitter.image && document.twitter.image.alt
        ? `<meta name="twitter:image:alt" content="${escapeAttribute(document.twitter.image.alt)}" />`
        : '',
    ];

    if (document.article) {
      if (document.article.publishedTime) {
        tags.push(`<meta property="article:published_time" content="${escapeAttribute(document.article.publishedTime)}" />`);
      }
      if (document.article.section) {
        tags.push(`<meta property="article:section" content="${escapeAttribute(document.article.section)}" />`);
      }
      document.article.authorUrls.forEach((authorUrl) => {
        tags.push(`<meta property="article:author" content="${escapeAttribute(authorUrl)}" />`);
      });
    }
    return tags.filter(Boolean);
  }

  renderSeoHead(document) {
    return [
      `<title>${escapeHtml(document.title)}</title>`,
      `<meta name="description" content="${escapeAttribute(document.description)}" />`,
      `<meta name="language" content="${escapeAttribute(document.language)}" />`,
      `<link rel="canonical" href="${escapeAttribute(document.canonical)}" />`,
      ...SeoRenderer.renderSocialMetadata(document),
      `<link rel="alternate" type="application/atom+xml" title="${FEED_TITLE}" href="${escapeAttribute(`${this.baseUrl}/feed.xml`)}" />`,
      `<script type="application/ld+json">${safeJson(document.structuredData)}</script>`,
    ].join('\n    ');
  }

  createWorkMetadata(issue, work, pages, coverWork = null) {
    const canonicalPath = workPath(work);
    const authorText = work.contributors.map((contributor) => contributor.displayName).join(', ');
    let workHtml = '';
    for (let page = work.startPage; page <= work.endPage; page += 1) {
      workHtml += pages[page] || '';
    }
    const artworkImage = work.type === 'visual'
      ? extractPrimaryImagePath(workHtml)
      : null;
    const metadataImage = artworkImage || issue.thumbnailURL;
    const structuredImage = metadataImage ? {
      pathname: metadataImage,
      usesIssueCover: !artworkImage,
    } : null;
    const excludedValues = [
      work.title,
      ...work.contributors.map((contributor) => contributor.displayName),
    ];
    const description = createDescription(workHtml, 160, excludedValues)
      || workFallbackDescription(issue, work);
    const publishedTime = toIsoDate(issue.publishDate);
    const structuredData = this.structuredData.work(
      { ...issue, publishDate: publishedTime },
      work,
      description,
      structuredImage,
      meaningfulWordCount(workHtml, excludedValues),
      coverWork,
    );

    return {
      title: `${work.title}${authorText ? ` — ${authorText}` : ''} | Galata Dergisi, Sayı ${issue.index}`,
      description,
      canonicalPath,
      image: metadataImage,
      imageAlt: work.type === 'visual'
        ? [work.title, authorText].filter(Boolean).join(' — ')
        : `Galata Dergisi Sayı ${issue.index} kapağı`,
      ogType: work.type === 'prose' || work.type === 'poetry'
        ? 'article'
        : 'website',
      publishedTime,
      articleSection: `Galata Dergisi Sayı ${issue.index}`,
      authorUrls: work.type === 'prose' || work.type === 'poetry'
        ? work.contributors.map(
          (contributor) => absoluteUrl(this.baseUrl, contributorPath(contributor)),
        )
        : [],
      structuredData,
    };
  }

  renderRightsPage() {
    const page = renderMarkdownPage(this.rightsPagePath);
    const metadata = {
      title: `${page.title} | Galata Dergisi`,
      description: page.description,
      canonicalPath: RIGHTS_PATH,
      image: '/images/header-logo.jpg',
      imageAlt: 'Galata Dergisi',
      ogType: 'website',
      structuredData: this.structuredData.rights(page.description, page.title),
    };
    const head = this.renderSeoHead(this.createSeoDocument(metadata));
    const document_ = `<!DOCTYPE html>
<html lang="tr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    ${head}
    <link rel="icon" type="image/png" href="/images/favicon.png" />
    <link rel="stylesheet" href="/assets/static-page.css" />
  </head>
  <body>
    <main class="static-page">
      <nav class="site-nav" aria-label="Ana sayfaya dönüş">
        <a href="/">← Galata Dergisi</a>
      </nav>
      <header>
        <h1>${escapeHtml(page.title)}</h1>
        <p class="lead">${escapeHtml(page.lead)}</p>
      </header>
      <div class="page-content">
        ${page.html.trim()}
      </div>
      <footer class="page-footer">
        <a href="/">← Galata Dergisi’ne dön</a>
      </footer>
    </main>
  </body>
</html>`;
    return this.assetManifest
      ? applyShellAssetVersions(document_, this.assetManifest)
      : document_;
  }

  createIssueMetadata(issue, coverWork = null, works = [], pages = {}) {
    const canonicalPath = `/dergiler/sayi${issue.index}`;
    const coverContributors = coverWork
      ? coverWork.contributors.map((contributor) => contributor.displayName)
      : [];
    const description = [
      `Galata Dergisi Sayı ${issue.index}, ${issue.publishDateText}.`,
      coverContributors.length ? `Kapak: ${coverContributors.join(', ')}.` : '',
      'Bu sayıdaki yazı, şiir, görsel ve ses çalışmalarını okuyun.',
    ].filter(Boolean).join(' ');
    const publishedTime = toIsoDate(issue.publishDate);
    const structuredData = this.structuredData.issue(
      { ...issue, publishDate: publishedTime },
      coverWork,
      works.length ? works : (coverWork ? [coverWork] : []),
      description,
      pages,
    );

    return {
      title: `Sayı ${issue.index}, ${issue.publishDateText} | Galata Dergisi`,
      description,
      canonicalPath,
      image: issue.thumbnailURL,
      imageAlt: `Galata Dergisi Sayı ${issue.index} kapağı`,
      ogType: 'website',
      publishedTime,
      structuredData,
    };
  }

  createHomeMetadata(magazines = []) {
    const description = 'Galata Dergisi. Tek, düzeleşmeyen dergi.';
    return {
      title: 'Galata Dergisi',
      description,
      canonicalPath: '/',
      image: '/images/header-logo.jpg',
      imageAlt: 'Galata Dergisi',
      ogType: 'website',
      structuredData: this.structuredData.home(
        magazines.map((magazine) => ({
          ...magazine,
          publishDate: toIsoDate(magazine.publishDate),
        })),
        description,
      ),
    };
  }

  renderDocument(props, metadata) {
    const template = this.getTemplate().replace(
      HOMEPAGE_CAROUSEL_PRELOAD_MARKER,
      props.initialMagazineIndex === null ? HOMEPAGE_CAROUSEL_PRELOAD : '',
    );
    const pageProps = {
      ...props,
      initialArtwork: this.homepageArtwork,
    };
    // Svelte's spread-prop SSR path mutates the selected magazine object.
    // Keep render state isolated and serialize the pristine bootstrap data.
    const bootstrapProps = clonePageProps(pageProps);
    const app = this.renderApp(clonePageProps(pageProps));
    const bootstrap = {
      ...bootstrapProps,
      hydratable: app.hydratable,
    };
    const head = this.renderSeoHead(this.createSeoDocument(metadata));
    const document_ = template
      .replace(/<title>[\s\S]*?<\/title>/gi, '')
      .replace(/\s*<meta\s+name=(?:"|')description(?:"|')[^>]*>/gi, '')
      .replace('</head>', `    ${head}\n  </head>`)
      .replace('<div id="app"></div>', `<div id="app">${app.html}</div>`)
      .replace('<script id="galata-bootstrap" type="application/json">{}</script>', [
        '<script id="galata-bootstrap" type="application/json">',
        safeJson(bootstrap),
        '</script>',
      ].join(''));

    return this.assetManifest
      ? applyShellAssetVersions(document_, this.assetManifest)
      : document_;
  }

  renderProfile(profile) {
    const canonicalPath = contributorPath(profile);
    const view = createProfileViewModel(profile);
    const description = `${profile.displayName}: Galata Dergisi ${view.issueRange}. ${view.summary}.`;
    const contributionGroups = PROFILE_CONTRIBUTION_GROUPS
      .map((group) => ({
        ...group,
        contributions: view.groupedContributions[group.key],
      }))
      .filter((group) => group.contributions.length);
    const flatProfile = view.totalRows <= FLAT_PROFILE_MAX_ROW_COUNT;
    const longProfile = view.totalRows >= LONG_PROFILE_ROW_COUNT;
    const searchableProfile = longProfile;
    const flatAnchors = new Set();
    const flatContributions = view.allContributions.map((contribution) => {
      const groupKey = profileContributionGroup(contribution);
      const group = PROFILE_CONTRIBUTION_GROUPS.find(({ key }) => key === groupKey);
      const anchorId = flatAnchors.has(groupKey) ? '' : group.anchorId;
      flatAnchors.add(groupKey);
      return renderProfileContributionRow(
        contribution,
        profile.displayName,
        anchorId,
      );
    }).join('');
    const groupedContributions = contributionGroups.map((group) => `
        <div class="contribution-group" id="${group.anchorId}">
          <h3>${group.title} <span>(${group.contributions.length})</span></h3>
          <ul class="contribution-list">${group.contributions.map(
    (contribution) => renderProfileContributionRow(contribution, profile.displayName),
  ).join('')}
          </ul>
        </div>`).join('');
    const contributionContent = view.totalRows
      ? (flatProfile
        ? `<ul class="contribution-list">${flatContributions}
        </ul>`
        : groupedContributions)
      : '';
    const contributionsSection = contributionContent ? `
      <section id="katkilari">
        <h2>Katkıları</h2>
        ${contributionContent}
      </section>` : '';
    const navigationDestinations = longProfile
      ? contributionGroups.map((group) => ({
          href: `#${group.anchorId}`,
          label: `${group.navigationTitle} (${group.contributions.length})`,
        }))
      : [];
    const sectionNavigationLinks = navigationDestinations.map((destination, index) => `
          <span class="section-nav-item">${index ? '<span aria-hidden="true">·</span>' : ''}
            <a href="${destination.href}">${destination.label}</a>
          </span>`).join('');
    const sectionNavigation = navigationDestinations.length > 1 ? `
        <nav class="section-nav" aria-label="Katkı bölümleri">
          ${sectionNavigationLinks}
        </nav>` : '';
    const searchInterface = searchableProfile ? `
      <form class="profile-search" role="search" hidden>
        <label for="katki-arama">Katkılarda ara</label>
        <input id="katki-arama" type="search" autocomplete="off"
          aria-describedby="katki-arama-durumu" />
        <p id="katki-arama-durumu" class="profile-search-status" aria-live="polite"></p>
      </form>
      <p class="profile-search-empty" hidden>Eşleşen katkı bulunamadı.</p>` : '';
    const searchScript = searchableProfile ? `
    <script src="/assets/contributor-profile.js" defer></script>` : '';
    const profileFooter = longProfile ? `
      <footer class="profile-footer">
        <a href="/">← Galata Dergisi</a>
        <a href="${RIGHTS_PATH}">Telif ve kullanım</a>
        <a href="#sayfa-basi">Başa dön ↑</a>
      </footer>` : '';
    const structuredData = this.structuredData.profile({
      ...profile,
      works: profile.works.map((work) => ({
        ...work,
        publishDate: toIsoDate(work.publishDate),
      })),
      recitations: profile.recitations.map((recitation) => ({
        ...recitation,
        publishDate: toIsoDate(recitation.publishDate),
      })),
      mediaContributions: view.mediaContributions.map((media) => ({
        ...media,
        publishDate: toIsoDate(media.publishDate),
      })),
    }, description);
    const metadata = {
      title: `${profile.displayName} | Galata Dergisi`,
      description,
      canonicalPath,
      image: '/images/header-logo.jpg',
      imageAlt: `${profile.displayName} — Galata Dergisi katkıda bulunan profili`,
      ogType: 'profile',
      structuredData,
    };
    const head = this.renderSeoHead(this.createSeoDocument(metadata));

    const document_ = `<!DOCTYPE html>
<html lang="tr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    ${head}
    <link rel="icon" type="image/png" href="/images/favicon.png" />
    <link rel="stylesheet" href="/assets/contributor-profile.css" />
  </head>
  <body>
    <main id="sayfa-basi" class="profile-${longProfile ? 'long' : 'compact'}">
      <header>
        <nav class="site-nav" aria-label="Site bağlantıları">
          <a href="/">← Galata Dergisi</a>
          <a href="${RIGHTS_PATH}">Telif ve kullanım</a>
        </nav>
        <h1>${escapeHtml(profile.displayName)}</h1>
        <p class="profile-summary">${escapeHtml(view.summary)}</p>
        <p class="issue-range">${escapeHtml(view.issueRangeLabel)}</p>${sectionNavigation}
      </header>
      ${searchInterface}
      ${contributionsSection}
      ${profileFooter}
    </main>
    ${searchScript}
  </body>
</html>`;
    return this.assetManifest
      ? applyShellAssetVersions(document_, this.assetManifest)
      : document_;
  }

  getBaseUrl() {
    return this.baseUrl;
  }
}

module.exports = SeoRenderer;
module.exports.absoluteUrl = absoluteUrl;
module.exports.contributorPath = contributorPath;
module.exports.mediaContributionPath = mediaContributionPath;
module.exports.storyNarrationSentence = storyNarrationSentence;
module.exports.toIsoDate = toIsoDate;
module.exports.workPath = workPath;
