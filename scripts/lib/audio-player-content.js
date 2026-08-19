// Copyright 2026 Mehmet Baker
//
// Converts the historical inline audio-player fragments into inert markup and
// structured data. The source order of the MP3 inputs is the playlist order.

const {
  escapeAttribute,
  escapeHtml,
  extractAttributes,
  isGenericReciter,
} = require('./seo-utils.js');
const iconLibrary = require('../../client/lib/font-awesome-icons.js');

const PLAYER_INPUT_REGEXP = /<input\b[^>]*\bname\s*=\s*(?:"player_songs"|'player_songs')[^>]*>/gi;

function parseReciterLinks(value) {
  if (!value) return [];
  try {
    const links = JSON.parse(value);
    return Array.isArray(links)
      ? links
        .filter((link) => link && link.name && (link.href || link.url))
        .map((link) => ({
          name: String(link.name),
          href: String(link.href || link.url),
        }))
      : [];
  } catch (_error) {
    return [];
  }
}

function renderReader(track) {
  if (!track.reciterLinks.length) return escapeHtml(track.reader);
  return track.reciterLinks
    .map((link) => `<a class="contributor-link" href="${escapeAttribute(link.href)}">${escapeHtml(link.name)}</a>`)
    .join(', ');
}

function renderControlIcon(name) {
  const icon = iconLibrary.getIcon(name);
  return [
    '<svg class="audio-control-icon" aria-hidden="true" focusable="false"',
    ` viewBox="${icon.viewBox}" xmlns="http://www.w3.org/2000/svg">`,
    `<use href="#${iconLibrary.symbolId(name)}" width="100%" height="100%"></use>`,
    '</svg>',
  ].join('');
}

function renderPlayerShell(player) {
  const track = player.tracks[0];
  const multipleTracks = player.tracks.length > 1;
  const navigationHidden = multipleTracks ? '' : ' hidden';

  return `<div class="audio-player-mount" data-audio-player-id="${escapeAttribute(player.id)}">
  <div class="player_container" data-audio-player-shell data-page-turn-gesture-boundary aria-busy="false">
    <div class="player_details">
      <div class="song_name" title="${escapeAttribute(track.title)}">${escapeHtml(track.title)}</div>
      <div class="song_artist" role="status" aria-live="polite" aria-atomic="true">${renderReader(track)}</div>
      <div class="player_track_navigation">
        <button type="button" class="player_previous" aria-label="Önceki kayıt"${navigationHidden}>
          ${renderControlIcon('audio-previous')}
        </button>
        <button type="button" class="player_next" aria-label="Sonraki kayıt"${navigationHidden}>
          ${renderControlIcon('audio-next')}
        </button>
      </div>
      <div class="horizontal_line"></div>
    </div>
    <button type="button" class="player_play" aria-label="Oynat">${renderControlIcon('audio-play')}</button>
    <div class="player_tracker_cont">
      <div class="player_tracker"></div>
      <div class="player_tracker_loaded"></div>
      <div class="player_tracker_current"></div>
      <div class="player_navigator"></div>
      <input class="player_seek_input" type="range" min="0" max="1000" value="0" step="1"
        aria-label="Kayıtta ilerle" aria-valuetext="00:00 / 00:00">
    </div>
    <div class="right_bound"></div>
    <div class="vertical-centering"><div class="player_time">00:00</div></div>
    <button type="button" class="player_volume_button" aria-label="Sesi kapat">${renderControlIcon('audio-volume-high')}</button>
    <div class="volume_cont">
      <div class="player_volume_bar"></div>
      <div class="player_volume_current" style="width: 75px"></div>
      <input class="player_volume_input" type="range" min="0" max="100" value="100" step="1" aria-label="Ses düzeyi">
    </div>
    <div class="right_bound"></div>
    <div style="clear:both;"></div>
    <div class="show_time" hidden aria-hidden="true"><div class="player_show_time put_time">00:00</div></div>
  </div>
</div>`;
}

function replaceBalancedDiv(source, openingRegexp, replacement) {
  const match = openingRegexp.exec(source);
  if (!match) return { html: source, replaced: false };

  const tagRegexp = /<div\b[^>]*>|<\/div\s*>/gi;
  tagRegexp.lastIndex = match.index;
  let depth = 0;
  let tag = tagRegexp.exec(source);
  let endIndex = -1;

  while (tag) {
    if (/^<\/div/i.test(tag[0])) {
      depth -= 1;
      if (depth === 0) {
        endIndex = tagRegexp.lastIndex;
        break;
      }
    } else {
      depth += 1;
    }
    tag = tagRegexp.exec(source);
  }

  if (endIndex < 0) {
    throw new Error('Unbalanced legacy player container');
  }

  return {
    html: `${source.slice(0, match.index)}${replacement}${source.slice(endIndex)}`,
    replaced: true,
  };
}

function buildCuratedByMp3(recitations) {
  return new Map(
    (recitations || [])
      .filter((recitation) => recitation.mp3Path)
      .map((recitation) => [recitation.mp3Path, recitation]),
  );
}

function extractPlayerTracks(html, context) {
  const inputs = String(html || '').match(PLAYER_INPUT_REGEXP) || [];
  const allSources = inputs.map((input) => extractAttributes(input));

  const curatedByMp3 = buildCuratedByMp3(context.recitations);
  return allSources
    .filter((attributes) => attributes.size === '1')
    .map((attributes, index) => {
      const mp3Path = attributes.src || attributes.class || '';
      const curated = curatedByMp3.get(mp3Path);
      const recitationId = attributes['data-recitation-id']
        || (curated && curated.anchorId)
        || null;
      const reader = attributes.reader || attributes.value || '';

      return {
        id: recitationId
          || `legacy-${context.issue}-${context.pageNumber}-${context.playerOrdinal}-${index + 1}`,
        title: attributes.title || attributes.id || '',
        reader,
        reciterLinks: isGenericReciter(reader)
          ? []
          : parseReciterLinks(attributes['data-reciter-links']),
        recitationId,
        sources: [{ src: mp3Path, type: 'audio/mpeg' }],
      };
    });
}

function removeLegacyPlayerRuntime(html) {
  let result = String(html || '');
  result = result.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (script) => (
    /\b(?:startPlayer|initPlayer)\s*\(/.test(script) ? '' : script
  ));
  result = result.replace(PLAYER_INPUT_REGEXP, '');
  result = result.replace(
    /<audio\b[^>]*\bid\s*=\s*(?:"player"|'player')[^>]*>[\s\S]*?<\/audio\s*>/gi,
    '',
  );
  result = replaceBalancedDiv(
    result,
    /<div\b[^>]*\bid\s*=\s*(?:"show_time"|'show_time')[^>]*>/i,
    '',
  ).html;
  return result;
}

function transformAudioPlayerPage(html, context) {
  const tracks = extractPlayerTracks(html, context);
  if (!tracks.length) return { html, players: [] };

  const player = {
    id: `audio-player-${context.issue}-${context.pageNumber}-${context.playerOrdinal}`,
    pageNumber: Number(context.pageNumber),
    tracks,
  };
  let transformed = removeLegacyPlayerRuntime(html);
  const replacement = replaceBalancedDiv(
    transformed,
    /<div\b[^>]*\bclass\s*=\s*(?:"[^"]*\bplayer_container\b[^"]*"|'[^']*\bplayer_container\b[^']*')[^>]*>/i,
    renderPlayerShell(player),
  );
  if (!replacement.replaced) {
    throw new Error(`Legacy player shell not found for issue ${context.issue}, page ${context.pageNumber}`);
  }
  transformed = replacement.html.replace(/<!--\s*End of Player\s*-->/i, '');
  return { html: transformed, players: [player] };
}

function transformIssueAudioPlayers(sourcePages, issue, recitations) {
  const pages = { ...sourcePages };
  const audioPlayers = {};

  Object.keys(pages).forEach((pageNumber) => {
    const result = transformAudioPlayerPage(pages[pageNumber], {
      issue: Number(issue),
      pageNumber: Number(pageNumber),
      playerOrdinal: 1,
      recitations,
    });
    pages[pageNumber] = result.html;
    if (result.players.length) audioPlayers[pageNumber] = result.players;
  });

  return { pages, audioPlayers };
}

module.exports = {
  extractPlayerTracks,
  renderPlayerShell,
  transformAudioPlayerPage,
  transformIssueAudioPlayers,
};
