// Copyright 2026 Mehmet Baker
//
// Builds deterministic, connected Schema.org graphs for canonical public pages.

function absoluteUrl(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl.replace(/\/+$/, '')}/`).toString();
}

function contributorPath(contributor) {
  return `/katkida-bulunanlar/${Number(contributor.id)}-${contributor.slug}`;
}

function workPath(work) {
  return work.kind === 'issue-cover'
    ? `/dergiler/sayi${Number(work.magazineIndex)}`
    : `/dergiler/sayi${Number(work.magazineIndex)}/${Number(work.startPage)}`;
}

function recitationTitle(recitation) {
  return recitation.poemTitle || '(başlık yok)';
}

function splitNames(value) {
  return String(value || '')
    .split(/\s*(?:,|;|\/|&|\bve\b)\s*/iu)
    .map((name) => name.trim())
    .filter(Boolean);
}

function peopleFromNames(value) {
  return splitNames(value).map((name) => ({
    '@type': 'Person',
    name,
  }));
}

function defined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => (
      value !== undefined && value !== null && value !== ''
    )),
  );
}

function typeForWork(work) {
  if (work.type === 'visual') return 'VisualArtwork';
  if (work.type === 'prose' || work.type === 'poetry') return 'Article';
  return 'CreativeWork';
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

const RIGHTS_PATH = '/telif-ve-kullanim';
const ORGANIZATION_OWNED_COVER_ISSUES = new Set([8, 9, 10, 11]);

class StructuredDataBuilder {
  constructor(baseUrl, mediaMetadata = new Map()) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.mediaMetadata = mediaMetadata;
    this.organizationId = `${this.baseUrl}/#organization`;
    this.websiteId = `${this.baseUrl}/#website`;
    this.periodicalId = `${this.baseUrl}/#periodical`;
    this.logoId = `${this.baseUrl}/#logo`;
    this.rightsUrl = absoluteUrl(this.baseUrl, RIGHTS_PATH);
  }

  media(pathname) {
    return this.mediaMetadata.get(pathname) || {};
  }

  organizationReference() {
    return {
      '@type': 'Organization',
      '@id': this.organizationId,
      name: 'Galata Dergisi',
      url: this.baseUrl,
    };
  }

  issueCoverCreators(issue, coverWork) {
    const creators = coverWork
      ? coverWork.contributors.map((contributor) => this.personReference(contributor))
      : [];
    if (creators.length) return creators;
    if (ORGANIZATION_OWNED_COVER_ISSUES.has(Number(issue.index))) {
      return [this.organizationReference()];
    }
    throw new Error(`Issue ${issue.index} cover requires a reviewed copyright owner`);
  }

  imageNode(pathname, id, caption, creators = []) {
    if (!pathname) return null;
    if (!creators.length) {
      throw new Error(`Image ${pathname} requires a reviewed copyright owner`);
    }
    const technical = this.media(pathname);
    const creditText = creators.map((creator) => creator.name).filter(Boolean).join(', ');
    if (!creditText) {
      throw new Error(`Image ${pathname} requires a named copyright owner`);
    }
    return defined({
      '@type': 'ImageObject',
      '@id': id,
      contentUrl: absoluteUrl(this.baseUrl, pathname),
      url: absoluteUrl(this.baseUrl, pathname),
      width: technical.width,
      height: technical.height,
      encodingFormat: technical.encodingFormat,
      caption,
      creator: creators,
      creditText,
      copyrightNotice: `© ${creditText}`,
      license: this.rightsUrl,
      acquireLicensePage: this.rightsUrl,
    });
  }

  personReference(contributor) {
    return {
      '@type': 'Person',
      '@id': `${absoluteUrl(
        this.baseUrl,
        contributorPath(contributor),
      )}#person`,
      name: contributor.displayName,
      url: absoluteUrl(this.baseUrl, contributorPath(contributor)),
    };
  }

  commonGraph() {
    const organization = this.organizationReference();
    const logo = this.imageNode(
      '/images/header-logo.jpg',
      this.logoId,
      'Galata Dergisi',
      [organization],
    );
    return [
      {
        ...organization,
        logo: { '@id': this.logoId },
        sameAs: [
          'https://twitter.com/GalataDergisi',
          'https://instagram.com/galatadergisi/',
        ],
      },
      logo,
      {
        '@type': 'WebSite',
        '@id': this.websiteId,
        name: 'Galata Dergisi',
        url: this.baseUrl,
        description: 'Galata Dergisi. Tek, düzeleşmeyen dergi.',
        inLanguage: 'tr',
        publisher: { '@id': this.organizationId },
      },
      {
        '@type': 'Periodical',
        '@id': this.periodicalId,
        name: 'Galata Dergisi',
        url: this.baseUrl,
        inLanguage: 'tr',
        publisher: { '@id': this.organizationId },
      },
    ].filter(Boolean);
  }

  breadcrumbNode(canonical, items) {
    return {
      '@type': 'BreadcrumbList',
      '@id': `${canonical}#breadcrumb`,
      itemListElement: items.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: item.name,
        item: absoluteUrl(this.baseUrl, item.pathname),
      })),
    };
  }

  issueReference(issue) {
    const canonical = absoluteUrl(
      this.baseUrl,
      `/dergiler/sayi${Number(issue.index)}`,
    );
    return {
      '@type': 'PublicationIssue',
      '@id': `${canonical}#issue`,
      name: `Galata Dergisi Sayı ${issue.index}`,
      issueNumber: String(issue.index),
      url: canonical,
      datePublished: issue.publishDate,
      isPartOf: { '@id': this.periodicalId },
      publisher: { '@id': this.organizationId },
    };
  }

  home(magazines, description) {
    const canonical = `${this.baseUrl}/`;
    const pageId = `${canonical}#webpage`;
    const listId = `${canonical}#issues`;
    return {
      '@context': 'https://schema.org',
      '@graph': [
        ...this.commonGraph(),
        {
          '@type': 'CollectionPage',
          '@id': pageId,
          url: canonical,
          name: 'Galata Dergisi',
          description,
          inLanguage: 'tr',
          isPartOf: { '@id': this.websiteId },
          publisher: { '@id': this.organizationId },
          mainEntity: { '@id': listId },
          primaryImageOfPage: { '@id': this.logoId },
        },
        {
          '@type': 'ItemList',
          '@id': listId,
          numberOfItems: magazines.length,
          itemListElement: magazines.map((magazine, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            item: {
              '@type': 'PublicationIssue',
              '@id': `${absoluteUrl(
                this.baseUrl,
                `/dergiler/sayi${magazine.index}`,
              )}#issue`,
              name: `Galata Dergisi Sayı ${magazine.index}`,
              url: absoluteUrl(
                this.baseUrl,
                `/dergiler/sayi${magazine.index}`,
              ),
              datePublished: magazine.publishDate,
            },
          })),
        },
      ],
    };
  }

  mediaNodes(issue, media, parentId) {
    const canonical = absoluteUrl(
      this.baseUrl,
      `/dergiler/sayi${issue.index}/${media.pageNumber}`,
    );
    const entityId = `${canonical}#${media.anchorId}`;
    const creators = (media.contributors || []).map(
      (contributor) => this.personReference(contributor),
    );
    const technical = media.technicalMetadata || this.media(media.mediaPath);
    if (media.kind === 'video') {
      return [defined({
        '@type': 'VideoObject',
        '@id': entityId,
        name: media.title,
        description: `${media.title}, Galata Dergisi Sayı ${issue.index}.`,
        url: entityId,
        contentUrl: absoluteUrl(this.baseUrl, media.mediaPath),
        thumbnailUrl: technical.thumbnailPath
          ? absoluteUrl(this.baseUrl, technical.thumbnailPath)
          : undefined,
        uploadDate: issue.publishDate,
        datePublished: issue.publishDate,
        duration: technical.duration,
        width: technical.width,
        height: technical.height,
        encodingFormat: technical.encodingFormat,
        contentSize: technical.contentSize
          ? String(technical.contentSize)
          : undefined,
        inLanguage: 'tr',
        isAccessibleForFree: true,
        creator: creators.length ? creators : undefined,
        isPartOf: { '@id': parentId },
      })];
    }

    const imageId = `${entityId}-image`;
    const artwork = defined({
      '@type': 'VisualArtwork',
      '@id': entityId,
      name: media.title,
      description: `${media.title}, Galata Dergisi Sayı ${issue.index}.`,
      url: entityId,
      artform: mediaKindLabel(media.kind),
      image: { '@id': imageId },
      creator: creators.length ? creators : undefined,
      inLanguage: 'tr',
      datePublished: issue.publishDate,
      isAccessibleForFree: true,
      publisher: { '@id': this.organizationId },
      isPartOf: { '@id': parentId },
    });
    return [
      artwork,
      this.imageNode(media.mediaPath, imageId, media.title, creators),
    ].filter(Boolean);
  }

  audioNode(issue, recitation, parentId) {
    const canonical = absoluteUrl(
      this.baseUrl,
      `/dergiler/sayi${issue.index}/${recitation.pageNumber}`,
    );
    const id = `${canonical}#${recitation.anchorId}`;
    const encodings = (recitation.encodings || []).filter(Boolean);
    const duration = encodings.find((encoding) => encoding.duration);
    return defined({
      '@type': 'AudioObject',
      '@id': id,
      name: recitationTitle(recitation),
      description: recitation.poetName
        ? `${recitationTitle(recitation)} — ${recitation.poetName}`
        : recitationTitle(recitation),
      url: id,
      contentUrl: encodings[0]
        ? absoluteUrl(this.baseUrl, encodings[0].publicPath)
        : undefined,
      duration: duration && duration.duration,
      datePublished: issue.publishDate,
      inLanguage: 'tr',
      isAccessibleForFree: true,
      creator: peopleFromNames(recitation.poetName),
      contributor: (recitation.contributors || []).map(
        (contributor) => this.personReference(contributor),
      ),
      isPartOf: { '@id': parentId },
      encoding: encodings.map((encoding) => ({
        '@type': 'MediaObject',
        '@id': `${id}-${encoding.encodingFormat.replace(/[^a-z0-9]+/gi, '-')}`,
        contentUrl: absoluteUrl(this.baseUrl, encoding.publicPath),
        encodingFormat: encoding.encodingFormat,
        contentSize: String(encoding.contentSize),
      })),
    });
  }

  issue(issue, coverWork, works, description) {
    const canonical = absoluteUrl(
      this.baseUrl,
      `/dergiler/sayi${issue.index}`,
    );
    const pageId = `${canonical}#webpage`;
    const issueId = `${canonical}#issue`;
    const coverId = `${canonical}#work`;
    const imageId = `${canonical}#primaryimage`;
    const coverCreators = this.issueCoverCreators(issue, coverWork);
    const coverMedia = coverWork
      ? (coverWork.media || []).flatMap(
        (media) => this.mediaNodes(issue, media, coverId),
      )
      : [];
    const issueNode = {
      ...this.issueReference(issue),
      '@id': issueId,
      description,
      image: { '@id': imageId },
      pageStart: Math.min(...works.map((work) => work.startPage)),
      pageEnd: Math.max(...works.map((work) => work.endPage)),
      pagination: `${Math.min(...works.map((work) => work.startPage))}-${Math.max(
        ...works.map((work) => work.endPage),
      )}`,
      inLanguage: 'tr',
      isAccessibleForFree: true,
      hasPart: works
        .filter((work) => work.kind !== 'issue-cover')
        .map((work) => ({
          '@type': typeForWork(work),
          '@id': `${absoluteUrl(this.baseUrl, workPath(work))}#work`,
          name: work.title,
          url: absoluteUrl(this.baseUrl, workPath(work)),
        })),
    };
    return {
      '@context': 'https://schema.org',
      '@graph': [
        ...this.commonGraph(),
        {
          '@type': 'CollectionPage',
          '@id': pageId,
          url: canonical,
          name: `Sayı ${issue.index}, ${issue.publishDateText} | Galata Dergisi`,
          description,
          inLanguage: 'tr',
          isPartOf: { '@id': this.websiteId },
          mainEntity: { '@id': issueId },
          primaryImageOfPage: { '@id': imageId },
          breadcrumb: { '@id': `${canonical}#breadcrumb` },
        },
        issueNode,
        {
          '@type': 'VisualArtwork',
          '@id': coverId,
          name: coverWork ? coverWork.title : `Sayı ${issue.index} Kapağı`,
          description,
          url: canonical,
          image: { '@id': imageId },
          creator: coverCreators,
          datePublished: issue.publishDate,
          inLanguage: 'tr',
          isAccessibleForFree: true,
          publisher: { '@id': this.organizationId },
          isPartOf: { '@id': issueId },
          hasPart: (coverWork && coverWork.media || []).map((media) => ({
            '@id': `${absoluteUrl(
              this.baseUrl,
              `/dergiler/sayi${issue.index}/${media.pageNumber}`,
            )}#${media.anchorId}`,
          })),
        },
        this.imageNode(
          issue.thumbnailURL,
          imageId,
          `Galata Dergisi Sayı ${issue.index} kapağı`,
          coverCreators,
        ),
        ...coverMedia,
        this.breadcrumbNode(canonical, [
          { name: 'Galata Dergisi', pathname: '/' },
          { name: `Sayı ${issue.index}`, pathname: `/dergiler/sayi${issue.index}` },
        ]),
      ].filter(Boolean),
    };
  }

  work(issue, work, description, primaryImage, wordCount, coverWork = null) {
    const canonical = absoluteUrl(this.baseUrl, workPath(work));
    const pageId = `${canonical}#webpage`;
    const workId = `${canonical}#work`;
    const imageId = primaryImage ? `${canonical}#primaryimage` : null;
    const creators = work.contributors.map(
      (contributor) => this.personReference(contributor),
    );
    const primaryImageCreators = primaryImage && primaryImage.usesIssueCover
      ? this.issueCoverCreators(issue, coverWork)
      : creators;
    const primaryImageCaption = primaryImage && primaryImage.usesIssueCover
      ? `Galata Dergisi Sayı ${issue.index} kapağı`
      : work.title;
    const type = typeForWork(work);
    const workNode = defined({
      '@type': type,
      '@id': workId,
      name: work.title,
      headline: type === 'Article' ? work.title : undefined,
      description,
      url: canonical,
      mainEntityOfPage: { '@id': pageId },
      inLanguage: 'tr',
      datePublished: issue.publishDate,
      image: imageId ? { '@id': imageId } : undefined,
      isPartOf: {
        '@id': `${absoluteUrl(
          this.baseUrl,
          `/dergiler/sayi${issue.index}`,
        )}#issue`,
      },
      publisher: { '@id': this.organizationId },
      isAccessibleForFree: true,
      pageStart: work.startPage,
      pageEnd: work.endPage,
      pagination: work.startPage === work.endPage
        ? String(work.startPage)
        : `${work.startPage}-${work.endPage}`,
      articleSection: type === 'Article'
        ? `Galata Dergisi Sayı ${issue.index}`
        : undefined,
      genre: type === 'Article' ? work.type : undefined,
      wordCount: type === 'Article' ? wordCount : undefined,
      artform: type === 'VisualArtwork' ? mediaKindLabel(work.kind) : undefined,
      author: type === 'Article' && creators.length ? creators : undefined,
      creator: type !== 'Article' && creators.length ? creators : undefined,
    });
    const audioNodes = (work.recitations || []).map(
      (recitation) => this.audioNode(issue, recitation, workId),
    );
    const mediaNodes = (work.media || []).flatMap(
      (media) => this.mediaNodes(issue, media, workId),
    );
    const partIds = [
      ...audioNodes.map((node) => ({ '@id': node['@id'] })),
      ...(work.media || []).map((media) => ({
        '@id': `${absoluteUrl(
          this.baseUrl,
          `/dergiler/sayi${issue.index}/${media.pageNumber}`,
        )}#${media.anchorId}`,
      })),
    ];
    if (partIds.length) workNode.hasPart = partIds;
    return {
      '@context': 'https://schema.org',
      '@graph': [
        ...this.commonGraph(),
        {
          '@type': 'WebPage',
          '@id': pageId,
          url: canonical,
          name: work.title,
          description,
          inLanguage: 'tr',
          isPartOf: { '@id': this.websiteId },
          mainEntity: { '@id': workId },
          primaryImageOfPage: imageId ? { '@id': imageId } : undefined,
          breadcrumb: { '@id': `${canonical}#breadcrumb` },
        },
        this.issueReference(issue),
        workNode,
        imageId
          ? this.imageNode(
            primaryImage.pathname,
            imageId,
            primaryImageCaption,
            primaryImageCreators,
          )
          : null,
        ...audioNodes,
        ...mediaNodes,
        this.breadcrumbNode(canonical, [
          { name: 'Galata Dergisi', pathname: '/' },
          { name: `Sayı ${issue.index}`, pathname: `/dergiler/sayi${issue.index}` },
          { name: work.title, pathname: workPath(work) },
        ]),
      ].filter(Boolean),
    };
  }

  profile(profile, description) {
    const canonical = absoluteUrl(this.baseUrl, contributorPath(profile));
    const pageId = `${canonical}#webpage`;
    const personId = `${canonical}#person`;
    const parts = [
      ...profile.works.map((work) => ({
        '@type': typeForWork(work),
        '@id': `${absoluteUrl(this.baseUrl, workPath(work))}#work`,
        name: work.title,
        url: absoluteUrl(this.baseUrl, workPath(work)),
        datePublished: work.publishDate,
        isPartOf: {
          '@id': `${absoluteUrl(
            this.baseUrl,
            `/dergiler/sayi${work.magazineIndex}`,
          )}#issue`,
        },
        ...(work.type === 'visual' ? {
          creator: { '@id': personId },
        } : {
          author: { '@id': personId },
        }),
      })),
      ...profile.mediaContributions.flatMap((media) => {
        const issue = {
          index: media.magazineIndex,
          publishDate: media.publishDate,
        };
        return this.mediaNodes(issue, media, `${absoluteUrl(
          this.baseUrl,
          `/dergiler/sayi${media.magazineIndex}/${media.startPage}`,
        )}#work`);
      }),
      ...profile.recitations.map((recitation) => ({
        '@type': 'AudioObject',
        '@id': `${absoluteUrl(
          this.baseUrl,
          `/dergiler/sayi${recitation.magazineIndex}/${recitation.pageNumber}`,
        )}#${recitation.anchorId}`,
        name: recitationTitle(recitation),
        url: `${absoluteUrl(
          this.baseUrl,
          `/dergiler/sayi${recitation.magazineIndex}/${recitation.pageNumber}`,
        )}#${recitation.anchorId}`,
        datePublished: recitation.publishDate,
        creator: peopleFromNames(recitation.poetName),
        contributor: { '@id': personId },
      })),
    ];
    return {
      '@context': 'https://schema.org',
      '@graph': [
        ...this.commonGraph(),
        {
          '@type': 'ProfilePage',
          '@id': pageId,
          url: canonical,
          name: `${profile.displayName} | Galata Dergisi`,
          description,
          inLanguage: 'tr',
          isPartOf: { '@id': this.websiteId },
          mainEntity: { '@id': personId },
          breadcrumb: { '@id': `${canonical}#breadcrumb` },
          hasPart: parts.map((part) => ({ '@id': part['@id'] })),
        },
        {
          '@type': 'Person',
          '@id': personId,
          identifier: String(profile.id),
          name: profile.displayName,
          url: canonical,
        },
        ...parts,
        this.breadcrumbNode(canonical, [
          { name: 'Galata Dergisi', pathname: '/' },
          { name: profile.displayName, pathname: contributorPath(profile) },
        ]),
      ].filter(Boolean),
    };
  }

  rights(description, title = 'Telif ve Kullanım') {
    const canonical = absoluteUrl(this.baseUrl, RIGHTS_PATH);
    const pageId = `${canonical}#webpage`;
    return {
      '@context': 'https://schema.org',
      '@graph': [
        ...this.commonGraph(),
        {
          '@type': 'WebPage',
          '@id': pageId,
          url: canonical,
          name: `${title} | Galata Dergisi`,
          description,
          inLanguage: 'tr',
          isPartOf: { '@id': this.websiteId },
          publisher: { '@id': this.organizationId },
          primaryImageOfPage: { '@id': this.logoId },
          breadcrumb: { '@id': `${canonical}#breadcrumb` },
        },
        this.breadcrumbNode(canonical, [
          { name: 'Galata Dergisi', pathname: '/' },
          { name: title, pathname: RIGHTS_PATH },
        ]),
      ],
    };
  }
}

module.exports = StructuredDataBuilder;
module.exports.RIGHTS_PATH = RIGHTS_PATH;
module.exports.typeForWork = typeForWork;
