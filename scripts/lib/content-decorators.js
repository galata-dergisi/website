// Copyright 2026 Mehmet Baker
//
// Public SEO-facing content queries and safe decoration of published page HTML.

const iconLibrary = require('../../client/lib/font-awesome-icons.js');
const {
  HTML_NAMESPACE,
  applyHtmlReplacements,
  assertClosedHtmlElement,
  collectHtmlElements,
  elementContent,
} = require('./html-policy.js');

const {
  canonicalizeContributorName,
  escapeAttribute,
  escapeHtml,
  extractAttributes,
  extractPageVisual,
  extractTitledPageVisual,
  extractTocEntries,
  normalizeText,
  splitVisibleContributorNames,
} = require('./seo-utils.js');

const legacyIconNames = new Set(iconLibrary.legacyIconNames);

function replaceLegacyFontAwesomeIcons(html) {
  const input = String(html || '');
  const replacements = [];
  const processedStarts = new Set();
  collectHtmlElements(input, { fragment: true })
    .filter((element) => (
      element.namespaceURI === HTML_NAMESPACE && element.tagName === 'i'
    ))
    .forEach((element) => {
      const classes = String(element.attributes.get('class') || '').split(/\s+/).filter(Boolean);
      if (!classes.includes('fas') && !classes.includes('fab')) return;
      if (processedStarts.has(element.startOffset)) return;
      processedStarts.add(element.startOffset);

      const openingTag = input.slice(element.startOffset, element.contentStartOffset);
      const sourceSelfClosing = /\/\s*>$/.test(openingTag);
      let end = element.contentStartOffset;
      if (!sourceSelfClosing) {
        assertClosedHtmlElement(element, 'Legacy Font Awesome markup');
        if (elementContent(input, element).trim() !== '') {
          throw new Error(`Unsupported Font Awesome markup: ${openingTag}`);
        }
        end = element.endOffset;
      }

      const iconClasses = classes.filter((className) => className.startsWith('fa-'));
      if (iconClasses.length !== 1) {
        throw new Error(`Expected one Font Awesome icon class in: ${openingTag}`);
      }

      const name = iconClasses[0].slice(3);
      let content = '';
      if (name !== 'certificate2') {
        if (!legacyIconNames.has(name)) {
          throw new Error(`Unmapped legacy Font Awesome icon: ${name}`);
        }

        const icon = iconLibrary.getIcon(name);
        const href = `#${iconLibrary.symbolId(name)}`;
        content = [
          `<svg class="legacy-icon legacy-icon-${name}"`,
          ` aria-hidden="true" focusable="false" viewBox="${icon.viewBox}"`,
          ' xmlns="http://www.w3.org/2000/svg">',
          `<use href="${href}" width="100%" height="100%"></use>`,
          '</svg>',
        ].join('');
      }
      replacements.push({ start: element.startOffset, end, content });
    });

  const decorated = applyHtmlReplacements(input, replacements);

  const unmatched = collectHtmlElements(decorated, { fragment: true }).find(
    (element) => {
      if (element.namespaceURI !== HTML_NAMESPACE || element.tagName !== 'i') return false;
      const classes = String(element.attributes.get('class') || '').split(/\s+/).filter(Boolean);
      return classes.includes('fas') || classes.includes('fab');
    },
  );
  if (unmatched) {
    const openingTag = decorated.slice(unmatched.startOffset, unmatched.contentStartOffset);
    throw new Error(`Unsupported Font Awesome markup: ${openingTag}`);
  }
  return decorated;
}

function profilePath(contributor) {
  return `/katkida-bulunanlar/${Number(contributor.id)}-${contributor.slug}`;
}

function appendTagAttributes(tag, attributes) {
  const serialized = Object.entries(attributes)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('');
  return tag.replace(/\s*\/?>$/, (ending) => `${serialized}${ending}`);
}

function setTagAttribute(tag, name, value) {
  const attribute = `${name}="${escapeAttribute(value)}"`;
  const regexp = new RegExp(`\\b${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'i');
  if (regexp.test(tag)) return tag.replace(regexp, attribute);
  return appendTagAttributes(tag, { [name]: value });
}

function addTagClass(tag, className) {
  if (/\bclass\s*=/i.test(tag)) {
    return tag.replace(
      /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
      (attribute, doubleQuoted, singleQuoted) => {
        const classes = (doubleQuoted === undefined ? singleQuoted : doubleQuoted)
          .split(/\s+/)
          .filter(Boolean);
        if (!classes.includes(className)) classes.push(className);
        return `class="${escapeAttribute(classes.join(' '))}"`;
      },
    );
  }
  return appendTagAttributes(tag, { class: className });
}

function addContributorLinkClass(tag) {
  return addTagClass(tag, 'contributor-link');
}

function retargetContributorAnchor(anchorHtml, contributor) {
  return anchorHtml.replace(/^<a\b[^>]*>/i, (openingTag) => {
    let tag = openingTag;
    const href = `href="${escapeAttribute(profilePath(contributor))}"`;
    if (/\bhref\s*=/i.test(tag)) {
      tag = tag.replace(
        /\bhref\s*=\s*(?:"[^"]*"|'[^']*')/i,
        href,
      );
    } else {
      tag = appendTagAttributes(tag, { href: profilePath(contributor) });
    }
    tag = tag
      .replace(/\s+target\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
      .replace(/\s+title\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
    return addContributorLinkClass(tag);
  });
}

function linkVisibleContributorName(html, visibleName, contributor) {
  let anchorLinked = false;
  const normalizedVisibleName = normalizeText(visibleName);
  let decorated = String(html || '').replace(
    /<a\b[^>]*>[\s\S]*?<\/a>/gi,
    (anchorHtml) => {
      if (
        anchorLinked
        || normalizeText(anchorHtml) !== normalizedVisibleName
      ) {
        return anchorHtml;
      }
      anchorLinked = true;
      return retargetContributorAnchor(anchorHtml, contributor);
    },
  );
  if (anchorLinked) return decorated;

  const escapedName = visibleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const visibleNameRegexp = new RegExp(escapedName);
  const tokens = decorated.split(/(<[^>]+>)/g);
  let insideAnchor = false;
  let textLinked = false;
  decorated = tokens.map((token) => {
    if (/^<a\b/i.test(token)) insideAnchor = true;
    if (/^<\/a\b/i.test(token)) insideAnchor = false;
    if (
      textLinked
      || insideAnchor
      || /^<[^>]+>$/.test(token)
      || !visibleNameRegexp.test(token)
    ) {
      return token;
    }
    textLinked = true;
    return token.replace(
      visibleNameRegexp,
      `<a class="contributor-link" href="${escapeAttribute(profilePath(contributor))}">${escapeHtml(visibleName)}</a>`,
    );
  }).join('');
  return decorated;
}

function decoratePageVisualContributorHtml(html, work) {
  const visual = extractPageVisual(html) || extractTitledPageVisual(html);
  if (!visual) return html;

  let decorated = String(html || '');
  visual.visibleContributors.forEach((visibleName, index) => {
    const canonicalName = visual.contributors[index];
    const contributor = work.contributors.find(
      (candidate) => normalizeText(candidate.displayName) === normalizeText(canonicalName),
    );
    if (contributor) {
      decorated = linkVisibleContributorName(decorated, visibleName, contributor);
    }
  });
  return decorated;
}

function decorateInlineMediaHtml(html, mediaItems) {
  let decorated = String(html || '');
  (mediaItems || []).forEach((media) => {
    const contributorNames = media.contributors
      .map((contributor) => contributor.displayName)
      .join(', ');
    const accessibleLabel = contributorNames
      ? `${media.title} — ${contributorNames}`
      : media.title;
    let mediaDecorated = false;

    if (media.kind === 'video') {
      decorated = decorated.replace(
        /<video\b[^>]*>[\s\S]*?<\/video>/gi,
        (videoHtml) => {
          if (mediaDecorated) return videoHtml;
          const sourceMatches = videoHtml.match(/<(?:video|source)\b[^>]*>/gi) || [];
          const matchesPath = sourceMatches.some((tag) => (
            extractAttributes(tag).src === media.mediaPath
          ));
          if (!matchesPath) return videoHtml;
          mediaDecorated = true;
          return videoHtml.replace(/<video\b[^>]*>/i, (openingTag) => (
            setTagAttribute(
              setTagAttribute(openingTag, 'id', media.anchorId),
              'aria-label',
              accessibleLabel,
            )
          ));
        },
      );
    } else {
      decorated = decorated.replace(
        /<a\b[^>]*>[\s\S]*?<\/a>/gi,
        (anchorHtml) => {
          if (mediaDecorated) return anchorHtml;
          const openingTag = anchorHtml.match(/^<a\b[^>]*>/i);
          if (
            !openingTag
            || extractAttributes(openingTag[0]).href !== media.mediaPath
            || !/<img\b/i.test(anchorHtml)
          ) {
            return anchorHtml;
          }
          mediaDecorated = true;
          return anchorHtml
            .replace(/^<a\b[^>]*>/i, (tag) => (
              setTagAttribute(tag, 'id', media.anchorId)
            ))
            .replace(/<img\b[^>]*>/i, (tag) => (
              setTagAttribute(tag, 'alt', accessibleLabel)
            ));
        },
      );

      if (!mediaDecorated) {
        decorated = decorated.replace(/<img\b[^>]*>/gi, (tag) => {
          if (
            mediaDecorated
            || extractAttributes(tag).src !== media.mediaPath
          ) {
            return tag;
          }
          mediaDecorated = true;
          return setTagAttribute(
            setTagAttribute(tag, 'id', media.anchorId),
            'alt',
            accessibleLabel,
          );
        });
      }
    }

    media.contributors.forEach((contributor) => {
      decorated = linkVisibleContributorName(
        decorated,
        contributor.displayName,
        contributor,
      );
    });
  });
  return decorated;
}

function linkVisibleContributorCredit(html, contributors) {
  let decorated = String(html || '');
  splitVisibleContributorNames(decorated).forEach((visibleName) => {
    const canonicalName = canonicalizeContributorName(visibleName);
    const contributor = contributors.find(
      (candidate) => (
        normalizeText(candidate.displayName) === normalizeText(canonicalName)
      ),
    );
    if (contributor) {
      decorated = linkVisibleContributorName(decorated, visibleName, contributor);
    }
  });
  return decorated;
}

function rewriteTocLinks(html, magazineIndex, tocPageNumber, mappings) {
  const mappingsByPosition = new Map(
    (mappings || [])
      .filter((mapping) => (
        Number(mapping.tocPageNumber) === Number(tocPageNumber)
      ))
      .map((mapping) => [Number(mapping.tocPosition), mapping]),
  );
  if (!mappingsByPosition.size) return html;

  let position = 0;
  const anchorRegexp = /<a\b[^>]*href\s*=\s*(?:"|')\/dergiler\/sayi(\d+)\/(\d+)(?:"|')[^>]*>[\s\S]*?<\/a>/gi;
  return String(html || '').replace(anchorRegexp, (anchorHtml, issue, linkedPage) => {
    if (Number(issue) !== Number(magazineIndex)) return anchorHtml;
    const currentPosition = position;
    position += 1;
    const mapping = mappingsByPosition.get(currentPosition);
    if (!mapping || Number(mapping.linkedPage) !== Number(linkedPage)) {
      return anchorHtml;
    }

    const [entry] = extractTocEntries(anchorHtml);
    if (
      !entry
      || normalizeText(entry.title) !== normalizeText(mapping.tocTitle)
      || normalizeText(entry.author) !== normalizeText(mapping.tocAuthor)
    ) {
      return anchorHtml;
    }

    return anchorHtml.replace(
      /(\bhref\s*=\s*)(["'])\/dergiler\/sayi\d+\/\d+\2/i,
      `$1$2/dergiler/sayi${Number(magazineIndex)}/${Number(mapping.actualStartPage)}$2`,
    );
  });
}

function linkRecitersInTable(tableHtml, recitations) {
  const contributors = [];
  const seenContributors = new Set();
  recitations.forEach((recitation) => {
    recitation.contributors.forEach((contributor) => {
      if (seenContributors.has(contributor.id)) return;
      seenContributors.add(contributor.id);
      contributors.push(contributor);
    });
  });

  return tableHtml.replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi, (rowHtml) => {
    const cells = [];
    const cellRegexp = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch = cellRegexp.exec(rowHtml);
    while (cellMatch !== null) {
      cells.push(cellMatch);
      cellMatch = cellRegexp.exec(rowHtml);
    }
    const isLabeledCredit = cells.length >= 2 && [
      normalizeText('Okuyan'),
      normalizeText('Okuyanlar'),
    ].includes(normalizeText(cells[0][1]));
    const isPositionalCredit = cells.length === 4
      && /^\d+\s*[.)-]?$/.test(String(cells[0][1]).trim());
    if (!isLabeledCredit && !isPositionalCredit) return rowHtml;

    const valueCell = cells[isPositionalCredit ? 3 : 1][0];
    const linkedCell = valueCell.replace(
      /(<td\b[^>]*>)([\s\S]*?)(<\/td>)/i,
      (cell, prefix, valueHtml, suffix) => (
        `${prefix}${linkVisibleContributorCredit(
          valueHtml,
          contributors,
        )}${suffix}`
      ),
    );
    return rowHtml.replace(valueCell, linkedCell);
  });
}

function linkPlainTextReciters(html, recitations) {
  const contributors = [];
  const seenContributors = new Set();
  recitations.forEach((recitation) => {
    recitation.contributors.forEach((contributor) => {
      if (seenContributors.has(contributor.id)) return;
      seenContributors.add(contributor.id);
      contributors.push(contributor);
    });
  });

  return String(html || '').replace(
    /(<([a-z0-9]+)\b[^>]*class=(?:"[^"]*\bmSiir\b[^"]*"|'[^']*\bmSiir\b[^']*')[^>]*>)([\s\S]*?)(<\/\2>)/gi,
    (block, prefix, tagName, innerHtml, suffix) => {
      const parts = innerHtml.split(/(<br\s*\/?>)/gi);
      const linked = parts.map((part) => {
        if (/^<br\b/i.test(part)) return part;
        const plainLine = part.replace(/<[^>]+>/g, ' ').trim();
        if (
          !/^\d+\s+[-–—]\s+.+?\s+[-–—]\s+.*?\s+[-–—]\s+.+$/u
            .test(plainLine)
        ) {
          return part;
        }
        return part.replace(
          /^(.*\s[-–—]\s)([^<\r\n]+?)(\s*)$/su,
          (line, linePrefix, reciterCredit, whitespace) => (
            `${linePrefix}${linkVisibleContributorCredit(
              reciterCredit,
              contributors,
            )}${whitespace}`
          ),
        );
      }).join('');
      return `${prefix}${linked}${suffix}`;
    },
  );
}

function linkStoryNarratorsInTable(tableHtml, recitations) {
  const contributors = new Map();
  recitations.forEach((recitation) => {
    recitation.contributors.forEach((contributor) => {
      contributors.set(normalizeText(contributor.displayName), contributor);
    });
  });
  let readingCharacters = false;

  return tableHtml.replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi, (rowHtml) => {
    const cells = [];
    const cellRegexp = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch = cellRegexp.exec(rowHtml);
    while (cellMatch !== null) {
      cells.push(cellMatch);
      cellMatch = cellRegexp.exec(rowHtml);
    }
    if (cells.length < 2) return rowHtml;

    const label = normalizeText(cells[0][1]);
    if (label === normalizeText('Sıra')) {
      readingCharacters = false;
      return rowHtml;
    }
    if (label === normalizeText('Karakterler')) {
      readingCharacters = true;
      return rowHtml;
    }
    if (!readingCharacters) return rowHtml;

    const contributor = contributors.get(normalizeText(
      canonicalizeContributorName(cells[1][1]),
    ));
    if (!contributor) return rowHtml;
    const valueCell = cells[1][0];
    const linkedCell = valueCell.replace(
      /(<td\b[^>]*>)([\s\S]*?)(<\/td>)/i,
      (cell, prefix, valueHtml, suffix) => (
        `${prefix}${linkVisibleContributorCredit(
          valueHtml,
          [contributor],
        )}${suffix}`
      ),
    );
    return rowHtml.replace(valueCell, linkedCell);
  });
}

function decorateWorkContributorHtml(html, work, magazineIndex, pageNumber) {
  if (!work.contributors.length) return html;
  let decorated = String(html || '');

  if (work.kind === 'issue-cover' && Number(pageNumber) === 1) {
    const contributorNames = work.contributors
      .map((contributor) => contributor.displayName)
      .join(', ');
    decorated = decorated.replace(/<img\b[^>]*>/i, (tag) => (
      /\balt\s*=/i.test(tag)
        ? tag
        : appendTagAttributes(tag, {
          alt: `Galata Dergisi Sayı ${Number(magazineIndex)} kapağı — ${contributorNames}`,
        })
    ));
  }

  if (work.kind === 'page-visual' && Number(pageNumber) === work.startPage) {
    decorated = decoratePageVisualContributorHtml(decorated, work);
    const contributorNames = work.contributors
      .map((contributor) => contributor.displayName)
      .join(', ');
    decorated = decorated.replace(/<img\b[^>]*>/i, (tag) => (
      setTagAttribute(
        tag,
        'alt',
        contributorNames ? `${work.title} — ${contributorNames}` : work.title,
      )
    ));
  }

  if (Number(pageNumber) === work.startPage) {
    decorated = decorated.replace(
      /(<([a-z0-9]+)\b[^>]*class=(?:"[^"]*\bmAuthor\b[^"]*"|'[^']*\bmAuthor\b[^']*')[^>]*>)([\s\S]*?)(<\/\2>)/i,
      (authorHtml, prefix, tagName, authorCredit, suffix) => (
        `${prefix}${linkVisibleContributorCredit(
          authorCredit,
          work.contributors,
        )}${suffix}`
      ),
    );
  }

  const tocAnchorRegexp = new RegExp(
    `(<a\\b[^>]*href=(?:"|')/dergiler/sayi${Number(magazineIndex)}/${work.startPage}(?:"|')[^>]*>)([\\s\\S]*?)(</a>)`,
    'gi',
  );
  decorated = decorated.replace(tocAnchorRegexp, (anchor, prefix, innerHtml, suffix) => {
    const authorMatch = innerHtml.match(
      /(<([a-z0-9]+)\b[^>]*class=(?:"[^"]*\bmContentsAuthors\b[^"]*"|'[^']*\bmContentsAuthors\b[^']*')[^>]*>)([\s\S]*?)(<\/\2>)/i,
    );
    if (!authorMatch) return anchor;
    const [
      authorHtml,
      authorPrefix,
      ,
      authorCredit,
      authorSuffix,
    ] = authorMatch;
    const linkedAuthorCredit = linkVisibleContributorCredit(
      authorCredit,
      work.contributors,
    );
    if (linkedAuthorCredit === authorCredit) return anchor;

    // A TOC entry is already an anchor to the work. Keep the contributor
    // profile anchor as a positioned sibling; nested anchors are invalid HTML
    // and browsers otherwise move the author outside its right-aligned span.
    const titleHtml = innerHtml.replace(authorHtml, '');
    const positionedAuthorPrefix = addTagClass(
      authorPrefix,
      'toc-contributor-links',
    );
    return [
      prefix,
      titleHtml,
      suffix,
      positionedAuthorPrefix,
      linkedAuthorCredit,
      authorSuffix,
    ].join('');
  });

  return decorated;
}

function decorateRecitationHtml(html, recitations) {
  if (!recitations || recitations.length === 0) return html;

  let decorated = linkPlainTextReciters(html, recitations);
  const anchoredRecitations = new Set();
  const recitationsByPath = new Map();

  recitations.forEach((recitation) => {
    if (recitation.mp3Path) recitationsByPath.set(recitation.mp3Path, recitation);
    if (recitation.oggPath) recitationsByPath.set(recitation.oggPath, recitation);
  });

  decorated = decorated.replace(
    /<table\b[^>]*>[\s\S]*?<\/table>/gi,
    (tableHtml) => {
      if (/(?:Öykü Adı|Karakterler)/i.test(tableHtml)) {
        return linkStoryNarratorsInTable(tableHtml, recitations);
      }
      return linkRecitersInTable(tableHtml, recitations);
    },
  );

  decorated = decorated.replace(
    /<input\b[^>]*\bname\s*=\s*(?:"|')player_songs(?:"|')[^>]*>/gi,
    (tag) => {
      const attributes = extractAttributes(tag);
      const recitation = recitationsByPath.get(attributes.class)
        || recitations.find((item) => normalizeText(item.poemTitle) === normalizeText(attributes.id));

      if (!recitation) return tag;

      const contributors = recitation.contributors.map((contributor) => ({
        name: contributor.displayName,
        url: profilePath(contributor),
      }));
      const decoratedTag = appendTagAttributes(tag, {
        'data-recitation-id': recitation.anchorId,
        'data-reciter-links': JSON.stringify(contributors),
      });

      if (anchoredRecitations.has(recitation.id)) return decoratedTag;
      anchoredRecitations.add(recitation.id);
      return `<span class="recitation-anchor" id="${escapeAttribute(recitation.anchorId)}"></span>${decoratedTag}`;
    },
  );

  return decorated;
}

module.exports = {
  decorateInlineMediaHtml,
  decoratePageVisualContributorHtml,
  decorateRecitationHtml,
  decorateWorkContributorHtml,
  profilePath,
  replaceLegacyFontAwesomeIcons,
  rewriteTocLinks,
};
