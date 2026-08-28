// Copyright 2026 Mehmet Baker
//
// In-memory representation of the canonical public SQLite catalog.

const {
  decorateInlineMediaHtml,
  decorateRecitationHtml,
  decorateWorkContributorHtml,
  replaceLegacyFontAwesomeIcons,
  rewriteTocLinks,
} = require('./content-decorators.js');
const { transformIssueAudioPlayers } = require('./audio-player-content.js');

function toNumber(value) {
  return Number(value);
}

function groupBy(rows, key) {
  const result = new Map();
  rows.forEach((row) => {
    const value = toNumber(row[key]);
    if (!result.has(value)) result.set(value, []);
    result.get(value).push(row);
  });
  return result;
}

class StaticPublicContent {
  constructor(reader, { homepageImages = null } = {}) {
    this.mediaMetadata = reader.all(`
      SELECT
        publicPath, encodingFormat, contentSize, duration,
        width, height, thumbnailPath
      FROM public_media_metadata ORDER BY publicPath
    `).map((item) => ({
      ...item,
      contentSize: toNumber(item.contentSize),
      width: item.width === null ? null : toNumber(item.width),
      height: item.height === null ? null : toNumber(item.height),
    }));
    this.mediaMetadataByPath = new Map(
      this.mediaMetadata.map((item) => [item.publicPath, item]),
    );

    this.magazines = reader.all(`
      SELECT id, publishDateText, thumbnailURL, tableOfContents, publishDate
      FROM magazines ORDER BY id DESC
    `).map((magazine) => {
      const index = toNumber(magazine.id);
      const generatedCover = homepageImages && homepageImages.covers
        ? homepageImages.covers[index]
        : null;
      return {
        index,
        publishDateText: magazine.publishDateText,
        thumbnailURL: magazine.thumbnailURL,
        thumbnailSources: generatedCover ? {
          avif: generatedCover.avif.map((asset) => ({
            src: asset.url,
            width: asset.width,
          })),
        } : { avif: [] },
        tableOfContents: toNumber(magazine.tableOfContents),
        publishDate: magazine.publishDate,
        thumbnailMetadata: this.mediaMetadataByPath.get(magazine.thumbnailURL),
      };
    });
    this.magazinesById = new Map(
      this.magazines.map((magazine) => [magazine.index, magazine]),
    );

    this.pagesByIssue = new Map();
    reader.all(`
      SELECT magazineIndex, pageNumber, content
      FROM pages ORDER BY magazineIndex, pageNumber
    `).forEach((page) => {
      const issue = toNumber(page.magazineIndex);
      if (!this.pagesByIssue.has(issue)) this.pagesByIssue.set(issue, {});
      this.pagesByIssue.get(issue)[toNumber(page.pageNumber)] = page.content;
    });

    this.contributors = reader.all(`
      SELECT id, displayName, normalizedName, slug
      FROM public_contributors ORDER BY id
    `).map((contributor) => ({
      ...contributor,
      id: toNumber(contributor.id),
    }));
    this.contributorsById = new Map(
      this.contributors.map((contributor) => [contributor.id, contributor]),
    );

    this.works = reader.all(`
      SELECT id, magazineIndex, startPage, endPage, title, type, kind
      FROM published_works ORDER BY magazineIndex, startPage, id
    `).map((work) => ({
      ...work,
      id: toNumber(work.id),
      magazineIndex: toNumber(work.magazineIndex),
      startPage: toNumber(work.startPage),
      endPage: toNumber(work.endPage),
      contributors: [],
      recitations: [],
      media: [],
    }));
    this.worksById = new Map(this.works.map((work) => [work.id, work]));
    this.worksByIssue = groupBy(this.works, 'magazineIndex');

    reader.all(`
      SELECT workId, contributorId, position, role
      FROM published_work_contributors
      ORDER BY workId, position, contributorId
    `).forEach((relationship) => {
      this.worksById.get(toNumber(relationship.workId)).contributors.push({
        ...this.contributorsById.get(toNumber(relationship.contributorId)),
        position: toNumber(relationship.position),
        role: relationship.role,
      });
    });

    const recitationsById = new Map();
    reader.all(`
      SELECT
        id, workId, sequence, pageNumber, kind, poemTitle, poetName,
        mp3Path, oggPath, anchorId
      FROM audio_recitations ORDER BY workId, sequence, id
    `).forEach((row) => {
      const recitation = {
        ...row,
        id: toNumber(row.id),
        workId: toNumber(row.workId),
        sequence: toNumber(row.sequence),
        pageNumber: toNumber(row.pageNumber),
        encodings: [row.mp3Path]
          .filter(Boolean)
          .map((publicPath) => this.mediaMetadataByPath.get(publicPath)),
        contributors: [],
      };
      recitationsById.set(recitation.id, recitation);
      this.worksById.get(recitation.workId).recitations.push(recitation);
    });
    reader.all(`
      SELECT recitationId, contributorId, position, role
      FROM audio_recitation_contributors
      ORDER BY recitationId, position, contributorId
    `).forEach((relationship) => {
      recitationsById.get(toNumber(relationship.recitationId)).contributors.push({
        ...this.contributorsById.get(toNumber(relationship.contributorId)),
        position: toNumber(relationship.position),
        role: relationship.role,
      });
    });
    this.recitations = Array.from(recitationsById.values());

    const mediaById = new Map();
    reader.all(`
      SELECT
        id, workId, pageNumber, position, title, kind, mediaPath,
        anchorId
      FROM published_work_media ORDER BY workId, pageNumber, position, id
    `).forEach((row) => {
      const media = {
        ...row,
        id: toNumber(row.id),
        workId: toNumber(row.workId),
        pageNumber: toNumber(row.pageNumber),
        position: toNumber(row.position),
        technicalMetadata: this.mediaMetadataByPath.get(row.mediaPath),
        contributors: [],
      };
      mediaById.set(media.id, media);
      this.worksById.get(media.workId).media.push(media);
    });
    reader.all(`
      SELECT mediaId, contributorId, position, role
      FROM published_work_media_contributors
      ORDER BY mediaId, position, contributorId
    `).forEach((relationship) => {
      mediaById.get(toNumber(relationship.mediaId)).contributors.push({
        ...this.contributorsById.get(toNumber(relationship.contributorId)),
        position: toNumber(relationship.position),
        role: relationship.role,
      });
    });
    this.media = Array.from(mediaById.values());

    this.tocMappingsByIssue = new Map();
    reader.all(`
      SELECT
        te.magazineIndex, te.tocPageNumber, te.tocPosition, te.linkedPage,
        te.tocTitle, te.tocAuthor, w.startPage AS actualStartPage
      FROM published_work_toc_entries te
      INNER JOIN published_works w ON w.id = te.workId
      ORDER BY te.magazineIndex, te.tocPageNumber, te.tocPosition
    `).forEach((mapping) => {
      const issue = toNumber(mapping.magazineIndex);
      if (!this.tocMappingsByIssue.has(issue)) {
        this.tocMappingsByIssue.set(issue, []);
      }
      this.tocMappingsByIssue.get(issue).push({
        ...mapping,
        magazineIndex: issue,
        tocPageNumber: toNumber(mapping.tocPageNumber),
        tocPosition: toNumber(mapping.tocPosition),
        linkedPage: toNumber(mapping.linkedPage),
        actualStartPage: toNumber(mapping.actualStartPage),
      });
    });
  }

  getPublishedMagazines() {
    return this.magazines;
  }

  getIssue(magazineIndex) {
    const issue = Number(magazineIndex);
    const magazine = this.magazinesById.get(issue);
    const pages = this.pagesByIssue.get(issue);
    const issuePages = pages ? { ...pages } : null;
    return magazine && issuePages ? { magazine, pages: issuePages } : null;
  }

  getWorkForPage(magazineIndex, pageNumber) {
    const page = Number(pageNumber);
    return (this.worksByIssue.get(Number(magazineIndex)) || [])
      .filter((work) => work.startPage <= page && work.endPage >= page)
      .sort((left, right) => right.startPage - left.startPage)[0] || null;
  }

  getWorksForIssue(magazineIndex) {
    return (this.worksByIssue.get(Number(magazineIndex)) || []).slice();
  }

  decorateIssuePages(magazineIndex, sourcePages) {
    const issue = Number(magazineIndex);
    const works = this.worksByIssue.get(issue) || [];
    const mappings = this.tocMappingsByIssue.get(issue) || [];
    const decorated = { ...sourcePages };

    Object.keys(decorated).forEach((pageNumber) => {
      decorated[pageNumber] = replaceLegacyFontAwesomeIcons(decorated[pageNumber]);
      decorated[pageNumber] = rewriteTocLinks(
        decorated[pageNumber],
        issue,
        pageNumber,
        mappings,
      );
      works.forEach((work) => {
        decorated[pageNumber] = decorateWorkContributorHtml(
          decorated[pageNumber],
          work,
          issue,
          pageNumber,
        );
      });
    });
    works.filter((work) => work.type === 'audio').forEach((work) => {
      for (let page = work.startPage; page <= work.endPage; page += 1) {
        if (decorated[page]) {
          decorated[page] = decorateRecitationHtml(
            decorated[page],
            work.recitations,
          );
        }
      }
    });
    works.forEach((work) => {
      work.media.forEach((media) => {
        if (decorated[media.pageNumber]) {
          decorated[media.pageNumber] = decorateInlineMediaHtml(
            decorated[media.pageNumber],
            [media],
          );
        }
      });
    });
    return decorated;
  }

  prepareIssuePages(magazineIndex, sourcePages) {
    const issue = Number(magazineIndex);
    return transformIssueAudioPlayers(
      this.decorateIssuePages(issue, sourcePages),
      issue,
      this.recitations.filter((recitation) => {
        const work = this.worksById.get(recitation.workId);
        return work && work.magazineIndex === issue;
      }),
    );
  }

  getContributorProfile(contributorId) {
    const id = Number(contributorId);
    const contributor = this.contributorsById.get(id);
    if (!contributor) return null;
    const works = this.works
      .filter((work) => work.contributors.some((item) => item.id === id))
      .map((work) => ({
        id: work.id,
        magazineIndex: work.magazineIndex,
        startPage: work.startPage,
        endPage: work.endPage,
        title: work.title,
        type: work.type,
        kind: work.kind,
        publishDateText: this.magazinesById.get(work.magazineIndex).publishDateText,
        publishDate: this.magazinesById.get(work.magazineIndex).publishDate,
      }));
    const recitations = this.recitations
      .filter((recitation) => recitation.contributors.some((item) => item.id === id))
      .map((recitation) => {
        const work = this.worksById.get(recitation.workId);
        const magazine = this.magazinesById.get(work.magazineIndex);
        const relationship = recitation.contributors.find((item) => item.id === id);
        return {
          id: recitation.id,
          pageNumber: recitation.pageNumber,
          kind: recitation.kind,
          poemTitle: recitation.poemTitle,
          poetName: recitation.poetName,
          anchorId: recitation.anchorId,
          role: relationship.role,
          magazineIndex: work.magazineIndex,
          startPage: work.startPage,
          publishDateText: magazine.publishDateText,
          publishDate: magazine.publishDate,
        };
      });
    const mediaContributions = this.media
      .filter((media) => media.contributors.some((item) => item.id === id))
      .map((media) => {
        const work = this.worksById.get(media.workId);
        const magazine = this.magazinesById.get(work.magazineIndex);
        return {
          id: media.id,
          pageNumber: media.pageNumber,
          title: media.title,
          kind: media.kind,
          mediaPath: media.mediaPath,
          anchorId: media.anchorId,
          technicalMetadata: media.technicalMetadata,
          contributors: media.contributors.map((contributor) => ({ ...contributor })),
          magazineIndex: work.magazineIndex,
          startPage: work.startPage,
          publishDateText: magazine.publishDateText,
          publishDate: magazine.publishDate,
        };
      });

    if (!works.length && !recitations.length && !mediaContributions.length) {
      return null;
    }
    return {
      id,
      displayName: contributor.displayName,
      slug: contributor.slug,
      works,
      recitations,
      mediaContributions,
    };
  }

  getSitemapData() {
    return {
      magazines: this.magazines
        .slice()
        .sort((left, right) => left.index - right.index)
        .map((magazine) => ({
          id: magazine.index,
          publishDate: magazine.publishDate,
        })),
      works: this.works.map((work) => ({
        magazineIndex: work.magazineIndex,
        startPage: work.startPage,
        kind: work.kind,
        publishDate: this.magazinesById.get(work.magazineIndex).publishDate,
      })),
      contributors: this.contributors.map((contributor) => {
        const profile = this.getContributorProfile(contributor.id);
        const dates = [
          ...profile.works.map((work) => work.publishDate),
          ...profile.recitations.map((recitation) => recitation.publishDate),
          ...profile.mediaContributions.map((media) => media.publishDate),
        ].filter(Boolean);
        return {
          id: contributor.id,
          slug: contributor.slug,
          lastModified: dates.sort().at(-1) || null,
        };
      }),
    };
  }
}

module.exports = StaticPublicContent;
