// Copyright 2026 Mehmet Baker
//
// This file is part of galata-dergisi.
//
// galata-dergisi is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

const contributorAliasDefinitions = require('../../content/contributor-aliases.json');

const HTML_ENTITIES = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

function decodeHtmlEntities(value = '') {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (entity, name) => HTML_ENTITIES[name.toLowerCase()] || entity);
}

function stripHtml(value = '') {
  return decodeHtmlEntities(
    String(value)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value = '') {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function normalizeText(value = '') {
  return stripHtml(value)
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const contributorAliases = new Map(
  contributorAliasDefinitions.map((entry) => [
    normalizeText(entry.alias),
    stripHtml(entry.canonicalName),
  ]),
);

function canonicalizeContributorName(value = '') {
  const displayName = stripHtml(value);
  return contributorAliases.get(normalizeText(displayName)) || displayName;
}

function getContributorAliases() {
  return contributorAliasDefinitions.map((entry) => ({ ...entry }));
}

function slugify(value = '') {
  return normalizeText(value).replace(/\s+/g, '-') || 'katkida-bulunan';
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function extractAttributes(tag = '') {
  const attributes = {};
  const regexp = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match = regexp.exec(tag);

  while (match !== null) {
    attributes[match[1].toLowerCase()] = decodeHtmlEntities(match[2] === undefined ? match[3] : match[2]);
    match = regexp.exec(tag);
  }

  return attributes;
}

function extractClassText(html, className) {
  const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regexp = new RegExp(
    `<([a-z0-9]+)\\b[^>]*class=(?:"[^"]*\\b${escapedClassName}\\b[^"]*"|'[^']*\\b${escapedClassName}\\b[^']*')[^>]*>([\\s\\S]*?)<\\/\\1>`,
    'i',
  );
  const match = String(html || '').match(regexp);
  return match ? stripHtml(match[2]) : '';
}

function extractTocEntries(html) {
  const entries = [];
  const anchorRegexp = /<a\b[^>]*href\s*=\s*(?:"|')\/dergiler\/sayi(\d+)\/(\d+)(?:"|')[^>]*>([\s\S]*?)<\/a>/gi;
  let match = anchorRegexp.exec(String(html || ''));

  while (match !== null) {
    const innerHtml = match[3];
    const authorMatch = innerHtml.match(
      /<span\b[^>]*class=(?:"[^"]*\bmContentsAuthors\b[^"]*"|'[^']*\bmContentsAuthors\b[^']*')[^>]*>([\s\S]*?)<\/span>/i,
    );
    const author = authorMatch ? stripHtml(authorMatch[1]) : '';
    const title = stripHtml(
      authorMatch ? innerHtml.replace(authorMatch[0], '') : innerHtml,
    );

    if (title) {
      entries.push({
        magazineIndex: Number(match[1]),
        startPage: Number(match[2]),
        title,
        author,
      });
    }
    match = anchorRegexp.exec(String(html || ''));
  }

  return entries;
}

function isPublicImagePath(value) {
  return /^(?:\/(?!\/)|https?:\/\/|\/\/)/i.test(String(value || ''))
    && /\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(String(value || ''));
}

function extractPrimaryImagePath(html) {
  const source = String(html || '');
  const anchorRegexp = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  let anchorMatch = anchorRegexp.exec(source);

  while (anchorMatch !== null) {
    if (/<img\b/i.test(anchorMatch[0])) {
      const openingTag = anchorMatch[0].match(/^<a\b[^>]*>/i);
      const attributes = openingTag ? extractAttributes(openingTag[0]) : {};
      if (isPublicImagePath(attributes.href)) return attributes.href;
    }
    anchorMatch = anchorRegexp.exec(source);
  }

  const imageTag = source.match(/<img\b[^>]*>/i);
  if (!imageTag) return null;
  const attributes = extractAttributes(imageTag[0]);
  return isPublicImagePath(attributes.src) ? attributes.src : null;
}

function splitVisibleContributorNames(value) {
  const text = stripHtml(value)
    .replace(/\s+(?:ve|&)\s+/gi, ',')
    .replace(/\s+[–—-]\s+/g, ',')
    .replace(/\s*;\s*/g, ',');

  return text
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name) => name !== '\u00a0');
}

function isPlausibleContributorName(value) {
  const name = String(value || '');
  if (
    !/^[\p{L}][\p{L}\p{M}’'._-]*(?:\s+[\p{L}][\p{L}\p{M}’'._-]*){0,4}$/u
      .test(name)
  ) {
    return false;
  }
  return name.split(/\s+/).every((word) => {
    const firstLetter = word.match(/\p{L}/u);
    return firstLetter
      && firstLetter[0] === firstLetter[0].toLocaleUpperCase('tr-TR');
  });
}

function extractPageVisual(html) {
  const source = String(html || '');
  if (
    !/<img\b/i.test(source)
    || /\bm(?:Author|Contents|Kunye|Nesir\d*|Siir\d*|Title)\b/i.test(source)
    || /\bplayer_songs\b/i.test(source)
  ) {
    return null;
  }

  const imagePath = extractPrimaryImagePath(source);
  const captionText = stripHtml(source);
  if (!imagePath || !captionText || captionText.length > 120) return null;

  const labelMatch = captionText.match(
    /^(Çizim|Fotoğraf|Görsel|İllüstrasyon)\s*:\s*(.+)$/iu,
  );
  if (!labelMatch && /\s[–—-]\s/u.test(captionText)) return null;
  const creditLabel = labelMatch ? labelMatch[1] : '';
  const creditText = labelMatch ? labelMatch[2].trim() : captionText;
  const visibleContributors = splitVisibleContributorNames(creditText);
  if (
    visibleContributors.length === 0
    || !visibleContributors.every((name) => isPlausibleContributorName(
      canonicalizeContributorName(name),
    ))
  ) {
    return null;
  }

  return {
    imagePath,
    captionText,
    creditLabel,
    creditText,
    visibleContributors,
    contributors: visibleContributors.map(canonicalizeContributorName),
  };
}

function extractTitledPageVisual(html) {
  const source = String(html || '');
  if (
    !/<img\b/i.test(source)
    || /\bm(?:Author|Contents|Kunye|Nesir\d*|Siir\d*|Title)\b/i.test(source)
    || /\bplayer_songs\b/i.test(source)
  ) {
    return null;
  }

  const imagePath = extractPrimaryImagePath(source);
  const captionText = stripHtml(source);
  if (!imagePath || !captionText || captionText.length > 180) return null;

  const captionMatch = captionText.match(/^(.+?)\s+[–—]\s+(.+)$/u);
  if (!captionMatch) return null;
  const title = captionMatch[1].trim();
  const creditText = captionMatch[2].trim();
  const visibleContributors = splitVisibleContributorNames(creditText);
  if (
    !title
    || title.length > 120
    || visibleContributors.length === 0
    || !visibleContributors.every((name) => isPlausibleContributorName(
      canonicalizeContributorName(name),
    ))
  ) {
    return null;
  }

  return {
    imagePath,
    captionText,
    title,
    creditText,
    visibleContributors,
    contributors: visibleContributors.map(canonicalizeContributorName),
  };
}

function isBackCoverPage(html) {
  const source = String(html || '');
  if (
    !/<img\b/i.test(source)
    || stripHtml(source)
    || /\bm(?:Author|Contents|Kunye|Nesir\d*|Siir\d*|Title)\b/i.test(source)
    || /\bplayer_songs\b/i.test(source)
  ) {
    return false;
  }

  const imagePath = extractPrimaryImagePath(source);
  if (!imagePath) return false;
  const pathname = imagePath.replace(/[?#].*$/, '');
  const basename = pathname.slice(pathname.lastIndexOf('/') + 1);
  return /(?:^|[_-])(?:arka|back)(?:[_-]|\.)/i.test(basename)
    || /(?:arkakapak|backcover)/i.test(basename);
}

function extractCoverContributors(html) {
  const source = String(html || '');
  const headingRegexp = /<td\b[^>]*class=(?:"[^"]*\bmKunyeTitle\b[^"]*"|'[^']*\bmKunyeTitle\b[^']*')[^>]*>\s*Kapak\s*<\/td>/i;
  const headingMatch = headingRegexp.exec(source);
  if (!headingMatch) return [];

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const remainingHtml = source.slice(sectionStart);
  const nextHeadingMatch = remainingHtml.match(
    /<td\b[^>]*class=(?:"[^"]*\bmKunyeTitle\b[^"]*"|'[^']*\bmKunyeTitle\b[^']*')[^>]*>/i,
  );
  const sectionHtml = nextHeadingMatch
    ? remainingHtml.slice(0, nextHeadingMatch.index)
    : remainingHtml;
  const candidates = [];
  const anchorRegexp = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let anchorMatch = anchorRegexp.exec(sectionHtml);

  while (anchorMatch !== null) {
    const name = stripHtml(anchorMatch[1]).replace(
      /\s*\((?:Instagram|Tumblr|Facebook|Twitter|X)\)\s*$/i,
      '',
    );
    if (name) candidates.push(name);
    anchorMatch = anchorRegexp.exec(sectionHtml);
  }

  if (candidates.length === 0) {
    const cellRegexp = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch = cellRegexp.exec(sectionHtml);
    while (cellMatch !== null) {
      const name = stripHtml(cellMatch[1]);
      if (name) candidates.push(name);
      cellMatch = cellRegexp.exec(sectionHtml);
    }
  }

  const seen = new Set();
  return candidates
    .map(canonicalizeContributorName)
    .filter((name) => {
      const normalizedName = normalizeText(name);
      if (!normalizedName || seen.has(normalizedName)) return false;
      seen.add(normalizedName);
      return true;
    });
}

function splitContributorNames(value) {
  return splitVisibleContributorNames(value)
    .map(canonicalizeContributorName);
}

function extractMetadataRows(html) {
  const rows = [];
  const rowRegexp = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch = rowRegexp.exec(String(html || ''));

  while (rowMatch !== null) {
    const cells = [];
    const cellRegexp = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch = cellRegexp.exec(rowMatch[1]);

    while (cellMatch !== null) {
      cells.push(cellMatch[1]);
      cellMatch = cellRegexp.exec(rowMatch[1]);
    }

    if (cells.length >= 2) {
      const label = stripHtml(cells[0]).replace(/\s*:\s*$/, '');
      if (label) {
        rows.push({
          index: rowMatch.index,
          label,
          value: stripHtml(cells[1]),
        });
      }
    }
    rowMatch = rowRegexp.exec(String(html || ''));
  }

  return rows;
}

function extractTableMetadata(html) {
  const source = String(html || '');
  const playerInputs = source.match(
    /<input\b[^>]*\bname\s*=\s*(?:"|')player_songs(?:"|')[^>]*>/gi,
  ) || [];
  const playerCredits = playerInputs.map((tag) => {
    const attributes = extractAttributes(tag);
    return {
      title: normalizeText(attributes.id),
      reciter: normalizeText(attributes.value),
    };
  });
  const matchesPlayer = (title, reciter) => playerCredits.some((player) => (
    (
      normalizeText(title)
      && player.title === normalizeText(title)
    )
    || (
      normalizeText(reciter)
      && player.reciter === normalizeText(reciter)
    )
  ));
  const tables = [];
  const tableRegexp = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
  let tableMatch = tableRegexp.exec(source);

  while (tableMatch !== null) {
    const tableHtml = tableMatch[0];
    const rows = extractMetadataRows(tableHtml);
    const canonicalLabel = (label) => {
      const normalized = normalizeText(label);
      if (normalized === normalizeText('Sıra')) return 'Sıra';
      if (normalized === normalizeText('Şair')) return 'Şair';
      if (normalized === normalizeText('Yazar')) return 'Şair';
      if (normalized === normalizeText('Şiir Adı')) return 'Şiir Adı';
      if (normalized === normalizeText('Tarih')) return 'Şiir Adı';
      if (normalized === normalizeText('Okuyan')) return 'Okuyan';
      if (normalized === normalizeText('Okuyanlar')) return 'Okuyanlar';
      return null;
    };
    const hasRecitationMetadata = rows.some((row) => (
      [
        normalizeText('Şair'),
        normalizeText('Şiir Adı'),
        normalizeText('Tarih'),
        normalizeText('Okuyan'),
        normalizeText('Okuyanlar'),
      ].includes(normalizeText(row.label))
    ));
    const isLiteraryReading = rows.some(
      (row) => normalizeText(row.label) === normalizeText('Yazar'),
    ) && rows.some(
      (row) => normalizeText(row.label) === normalizeText('Tarih'),
    );

    if (hasRecitationMetadata) {
      const records = [];
      let current = null;
      const finishCurrent = () => {
        if (
          current
          && (
            current.values['Şiir Adı']
            || current.values.Şair
            || current.values.Okuyan
            || current.values.Okuyanlar
          )
        ) {
          records.push(current);
        }
        current = null;
      };

      rows.forEach((row) => {
        const label = canonicalLabel(row.label);
        if (!label) return;
        if (label === 'Sıra') {
          finishCurrent();
          current = {
            index: row.index,
            values: { Sıra: row.value },
          };
          return;
        }
        if (!current) {
          current = {
            index: row.index,
            values: {},
          };
        }
        if (
          (label === 'Şair' && current.values['Şiir Adı'])
          || (label === 'Şiir Adı' && current.values['Şiir Adı'])
          || (
            ['Okuyan', 'Okuyanlar'].includes(label)
            && (current.values.Okuyan || current.values.Okuyanlar)
          )
        ) {
          finishCurrent();
          current = {
            index: row.index,
            values: {},
          };
        }
        current.values[label] = row.value;
      });
      finishCurrent();

      records.forEach((record, recordIndex) => {
        tables.push({
          html: tableHtml,
          index: tableMatch.index + record.index,
          tableIndex: tables.length,
          recordIndex,
          kind: isLiteraryReading ? 'literary-reading' : 'poetry-recitation',
          values: record.values,
        });
      });
    } else {
      const positionalRows = [];
      const rowRegexp = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowMatch = rowRegexp.exec(tableHtml);
      while (rowMatch !== null) {
        const cells = [];
        const cellRegexp = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
        let cellMatch = cellRegexp.exec(rowMatch[1]);
        while (cellMatch !== null) {
          cells.push(stripHtml(cellMatch[1]));
          cellMatch = cellRegexp.exec(rowMatch[1]);
        }
        const sequence = cells[0] || '';
        const poetName = cells[1] || '';
        const poemTitle = cells[2] || '';
        const reciter = cells[3] || '';
        if (
          cells.length === 4
          && /^\d+\s*[.)-]?$/.test(sequence)
          && poetName
          && reciter
          && (!playerCredits.length || matchesPlayer(poemTitle, reciter))
        ) {
          positionalRows.push({
            html: tableHtml,
            index: tableMatch.index + rowMatch.index,
            tableIndex: tables.length,
            recordIndex: positionalRows.length,
            kind: 'poetry-recitation',
            values: {
              Sıra: sequence.replace(/\D/g, ''),
              Şair: poetName,
              'Şiir Adı': poemTitle,
              Okuyan: reciter,
            },
          });
        }
        rowMatch = rowRegexp.exec(tableHtml);
      }
      tables.push(...positionalRows);
    }
    tableMatch = tableRegexp.exec(source);
  }

  const blockRegexp = /<([a-z0-9]+)\b[^>]*class=(?:"[^"]*\bmSiir\b[^"]*"|'[^']*\bmSiir\b[^']*')[^>]*>([\s\S]*?)<\/\1>/gi;
  let blockMatch = blockRegexp.exec(source);
  while (blockMatch !== null) {
    const plainText = blockMatch[2]
      .replace(/<br\s*\/?>/gi, '\n')
      .split(/\n+/)
      .map((line) => stripHtml(line))
      .filter(Boolean);
    plainText.forEach((line, recordIndex) => {
      const match = line.match(
        /^(\d+)\s+[-–—]\s+(.+?)\s+[-–—]\s+(.*?)\s+[-–—]\s+(.+)$/u,
      );
      if (!match) return;
      const poetName = match[2].trim();
      const poemTitle = match[3].trim();
      const reciter = match[4].trim();
      if (playerCredits.length && !matchesPlayer(poemTitle, reciter)) return;
      tables.push({
        html: blockMatch[0],
        index: blockMatch.index + recordIndex,
        tableIndex: null,
        recordIndex,
        kind: 'poetry-recitation',
        values: {
          Sıra: match[1],
          Şair: poetName,
          'Şiir Adı': poemTitle,
          Okuyan: reciter,
        },
      });
    });
    blockMatch = blockRegexp.exec(source);
  }

  return tables.sort((left, right) => left.index - right.index);
}

function extractStoryNarrationMetadata(html) {
  const narrations = [];
  let current = null;
  let readingCharacters = false;

  const finishCurrent = () => {
    if (!current || !current.values['Öykü Adı']) return;
    const seenReciters = new Set();
    const reciters = current.roles
      .map((role) => role.name)
      .filter((name) => {
        const normalizedName = normalizeText(name);
        if (!normalizedName || seenReciters.has(normalizedName)) return false;
        seenReciters.add(normalizedName);
        return true;
      });

    narrations.push({
      html: '',
      index: current.index,
      kind: 'story-narration',
      roles: current.roles,
      values: {
        ...current.values,
        'Şiir Adı': current.values['Öykü Adı'],
        Şair: current.values.Yazar || '',
        Okuyanlar: reciters.join(', '),
      },
    });
  };

  extractMetadataRows(html).forEach((row) => {
    const normalizedLabel = normalizeText(row.label);

    if (normalizedLabel === normalizeText('Sıra')) {
      finishCurrent();
      current = {
        index: row.index,
        roles: [],
        values: { Sıra: row.value },
      };
      readingCharacters = false;
      return;
    }

    if (!current) return;

    if (normalizedLabel === normalizeText('Yazar')) {
      current.values.Yazar = row.value;
      return;
    }

    if (normalizedLabel === normalizeText('Öykü Adı')) {
      current.values['Öykü Adı'] = row.value;
      return;
    }

    if (normalizedLabel === normalizeText('Karakterler')) {
      readingCharacters = true;
      return;
    }

    if (readingCharacters && row.value) {
      current.roles.push({
        role: row.label,
        name: row.value,
      });
    }
  });
  finishCurrent();

  return narrations;
}

function isGenericReciter(value) {
  return normalizeText(value) === normalizeText('Galata Dergisi Ses Makinesi Ekibi');
}

function sameContributorSet(left, right) {
  const normalizedLeft = splitContributorNames(left).map(normalizeText).sort();
  const normalizedRight = splitContributorNames(right).map(normalizeText).sort();
  return normalizedLeft.length > 0
    && normalizedLeft.join('\u0000') === normalizedRight.join('\u0000');
}

function extractRecitationMetadata(html) {
  return [
    ...extractTableMetadata(html),
    ...extractStoryNarrationMetadata(html),
  ]
    .sort((left, right) => left.index - right.index)
    .map((metadata, metadataTableIndex) => ({
      poemTitle: metadata.values['Şiir Adı'] || '',
      poetName: metadata.values['Şair'] || '',
      reciters: splitContributorNames(
        metadata.values.Okuyanlar || metadata.values.Okuyan || '',
      ),
      kind: metadata.kind || 'poetry-recitation',
      reciterRoles: metadata.roles || [],
      metadataTableIndex,
      metadataSourceIndex: metadata.index,
    }));
}

function extractRecitations(html) {
  const inputTags = String(html || '').match(/<input\b[^>]*\bname\s*=\s*(?:"|')player_songs(?:"|')[^>]*>/gi) || [];
  const tracks = [];

  inputTags.forEach((tag) => {
    const attributes = extractAttributes(tag);
    const title = stripHtml(attributes.id || '');
    const playerCredit = stripHtml(attributes.value || '');
    const path = attributes.class || '';
    const key = `${normalizeText(title)}\u0000${normalizeText(playerCredit)}`;
    let format = attributes.size === '1' ? 'mp3Path' : 'oggPath';
    if (/\.mp3(?:$|\?)/i.test(path)) format = 'mp3Path';
    if (/\.ogg(?:$|\?)/i.test(path)) format = 'oggPath';
    const exactDuplicate = tracks.some((candidate) => (
      candidate.key === key && candidate[format] === path
    ));
    if (exactDuplicate) return;

    let track = tracks.find((candidate) => (
      candidate.key === key && !candidate[format]
    ));

    if (!track) {
      track = {
        key,
        sequence: tracks.length + 1,
        playerTitle: title,
        poemTitle: title,
        poetName: '',
        playerCredit,
        reciters: [],
        mp3Path: null,
        oggPath: null,
        warnings: [],
      };
      tracks.push(track);
    }

    track[format] = path;
  });

  const metadataTables = extractRecitationMetadata(html);
  const unusedTables = new Set(metadataTables.map((_, index) => index));
  const tableAssignments = tracks.map(() => -1);
  const getVisibleReciters = (table) => table.reciters.join(', ');
  const assignTables = (predicate) => {
    tracks.forEach((track, trackIndex) => {
      if (tableAssignments[trackIndex] !== -1) return;
      const tableIndex = metadataTables.findIndex((table, index) => (
        unusedTables.has(index) && predicate(track, table)
      ));
      if (tableIndex !== -1) {
        tableAssignments[trackIndex] = tableIndex;
        unusedTables.delete(tableIndex);
      }
    });
  };

  assignTables((track, table) => (
    track.playerCredit
    && !isGenericReciter(track.playerCredit)
    && sameContributorSet(track.playerCredit, getVisibleReciters(table))
    && normalizeText(table.poemTitle) === normalizeText(track.poemTitle)
  ));
  assignTables((track, table) => (
    track.playerCredit
    && !isGenericReciter(track.playerCredit)
    && sameContributorSet(track.playerCredit, getVisibleReciters(table))
  ));
  assignTables((track, table) => (
    normalizeText(table.poemTitle) === normalizeText(track.poemTitle)
  ));

  if (metadataTables.length === tracks.length) {
    tracks.forEach((track, trackIndex) => {
      if (tableAssignments[trackIndex] === -1 && unusedTables.has(trackIndex)) {
        tableAssignments[trackIndex] = trackIndex;
        unusedTables.delete(trackIndex);
      }
    });
  }

  tracks.forEach((track, trackIndex) => {
    const tableIndex = tableAssignments[trackIndex];
    const metadata = tableIndex === -1 ? null : metadataTables[tableIndex];

    if (metadata) {
      track.poemTitle = metadata.poemTitle || track.poemTitle;
      track.poetName = metadata.poetName;
      track.reciters = metadata.reciters;
      track.kind = metadata.kind || 'poetry-recitation';
      track.reciterRoles = metadata.reciterRoles;
      track.metadataTableIndex = tableIndex;

      if (
        track.playerCredit
        && !isGenericReciter(track.playerCredit)
        && track.poetName
        && track.reciters.length === 1
        && !sameContributorSet(track.playerCredit, track.reciters.join(', '))
        && sameContributorSet(track.playerCredit, track.poetName)
      ) {
        const [visibleOriginalCreator] = track.reciters;
        track.poetName = visibleOriginalCreator;
        track.reciters = splitContributorNames(track.playerCredit);
      }
    }

    if (track.reciters.length === 0 && track.playerCredit) {
      track.reciters = splitContributorNames(track.playerCredit);
    }

    if (track.reciters.length === 0) {
      track.warnings.push('Named reciters could not be resolved.');
    }

    if (!track.mp3Path) {
      track.warnings.push('MP3 source is not referenced in the page markup.');
    }

    if (!track.oggPath) {
      track.warnings.push('OGG source is not referenced in the page markup.');
    }

    if (
      track.playerCredit
      && !isGenericReciter(track.playerCredit)
      && track.reciters.length
    ) {
      const playerNames = splitContributorNames(track.playerCredit)
        .join(', ');
      const visibleNames = track.reciters.join(', ');
      if (!sameContributorSet(playerNames, visibleNames)) {
        track.warnings.push(
          `Player credit "${track.playerCredit}" does not match the visible reciter metadata.`,
        );
      }
    }

    delete track.key;
  });

  return tracks;
}

function inferWorkType(content = '', title = '') {
  if (normalizeText(title) === normalizeText('Ses Makinesi')) return 'audio';
  if (/\bmSiir\d*\b/i.test(content)) return 'poetry';
  if (/\bmNesir\d*\b/i.test(content)) return 'prose';
  if (/<img\b/i.test(content) && stripHtml(content).length < 120) return 'visual';
  return 'creative-work';
}

function createDescription(html, maximumLength = 160, excludedValues = []) {
  let text = stripHtml(html);
  [
    ...excludedValues,
    'Önceki',
    'Sonraki',
    'Oynat',
    'Duraklat',
    'Ses',
    'Ses düzeyi',
    'Tarayıcınız video oynatmayı desteklemiyor.',
  ]
    .map((value) => stripHtml(value))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .forEach((value) => {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(escaped, 'giu'), ' ');
    });
  text = text
    .replace(/(?:^|\s)@[\p{L}\p{N}_.-]+(?=\s|$)/gu, ' ')
    .split(/\s+/u)
    .filter((token) => !/^\d+$/u.test(token))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = text.match(/[\p{L}\p{N}]+/gu) || [];
  const meaningfulCharacters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  if (words.length < 12 || meaningfulCharacters < 80) return '';
  if (text.length <= maximumLength) return text;
  const truncated = text.slice(0, maximumLength + 1);
  const lastSpace = truncated.lastIndexOf(' ');
  return `${truncated.slice(0, lastSpace > 80 ? lastSpace : maximumLength).trim()}…`;
}

module.exports = {
  canonicalizeContributorName,
  createDescription,
  decodeHtmlEntities,
  escapeAttribute,
  escapeHtml,
  extractAttributes,
  extractClassText,
  extractCoverContributors,
  extractPageVisual,
  extractPrimaryImagePath,
  extractRecitationMetadata,
  extractRecitations,
  extractStoryNarrationMetadata,
  extractTableMetadata,
  extractTitledPageVisual,
  extractTocEntries,
  getContributorAliases,
  inferWorkType,
  isBackCoverPage,
  isGenericReciter,
  normalizeText,
  safeJson,
  sameContributorSet,
  slugify,
  splitContributorNames,
  splitVisibleContributorNames,
  stripHtml,
};
