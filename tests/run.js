#! /usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  canonicalizeContributorName,
  createDescription,
  extractCoverContributors,
  extractPageVisual,
  extractPrimaryImagePath,
  extractRecitations,
  extractTitledPageVisual,
  extractTocEntries,
  getContributorAliases,
  isBackCoverPage,
  normalizeText,
  slugify,
  stripHtml,
} = require('../scripts/lib/seo-utils.js');
const {
  decorateInlineMediaHtml,
  decoratePageVisualContributorHtml,
  decorateRecitationHtml,
  decorateWorkContributorHtml,
  replaceLegacyFontAwesomeIcons,
  rewriteTocLinks,
} = require('../scripts/lib/content-decorators.js');
const iconLibrary = require('../client/lib/font-awesome-icons.js');
const SeoRenderer = require('../scripts/lib/seo-renderer.js');
const {
  renderMarkdownPageSource,
} = require('../scripts/lib/static-markdown-page.js');
const { renderAtomFeed } = require('../scripts/lib/atom-feed.js');
const { renderSitemap } = require('../scripts/lib/sitemap.js');
const {
  DEVELOPMENT_RUNTIME_PATH,
  DEVELOPMENT_RUNTIME_SOURCE,
  renderDevelopmentDocument,
} = require('../scripts/lib/development-rendering.js');
const {
  parseOptions: parseGeneratorOptions,
} = require('../scripts/generate-site.js');
const {
  collectDevelopmentMedia,
  inspectDevelopmentMedia,
  relativeMediaPath,
} = require('../scripts/lib/development-media.js');
const { openReadOnly } = require('../scripts/lib/sqlite-reader.js');
const StaticPublicContent = require('../scripts/lib/static-public-content.js');
const {
  transformAudioPlayerPage,
} = require('../scripts/lib/audio-player-content.js');
const {
  collectHtmlElements,
} = require('../scripts/lib/html-policy.js');

const carouselStateModule = import(
  '../client/pages/homepage/components/carousel-state.mjs'
);
const carouselPlaceholderModule = import(
  '../client/pages/homepage/components/carousel-placeholder.mjs'
);
const audioPlayerStateModule = import('../client/lib/audio-player-state.mjs');
const audioPlayerControllerModule = import('../client/lib/audio-player-controller.mjs');

const { mediaContributionPath, workPath } = SeoRenderer;

const tests = [];

function structuredDataFromHtml(html) {
  const match = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  );
  assert(match, 'structured data script is missing');
  return JSON.parse(match[1]);
}

function graphNode(structuredData, predicate) {
  return (structuredData['@graph'] || []).find(predicate);
}

function relativeLuminance(color) {
  const channels = color.match(/[a-f0-9]{2}/gi).map((pair) => {
    const value = parseInt(pair, 16) / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const luminances = [
    relativeLuminance(foreground),
    relativeLuminance(background),
  ].sort((left, right) => right - left);
  return (luminances[0] + 0.05) / (luminances[1] + 0.05);
}

function test(name, callback) {
  tests.push({ name, callback });
}

function createManualTimers() {
  let nextId = 1;
  let setCount = 0;
  const pending = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      setCount += 1;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    fire(delay) {
      const entry = Array.from(pending.entries())
        .find(([, timer]) => timer.delay === delay);
      if (!entry) return false;
      const [id, timer] = entry;
      pending.delete(id);
      timer.callback();
      return true;
    },
    pendingCount: () => pending.size,
    setCount: () => setCount,
  };
}

test('replaces the complete legacy Font Awesome icon set with inline SVG references', () => {
  const brandIcons = new Set(['instagram', 'instagram-square', 'tumblr-square', 'twitter']);
  const source = iconLibrary.legacyIconNames.map((name, index) => {
    const style = brandIcons.has(name) ? 'fab' : 'fas';
    const icon = index % 2 === 0
      ? `<i class="${style} fa-${name}" />`
      : `<i class="${style} fa-${name}"></i>`;
    return `<a href="/${name}">${icon}<span>${name}</span></a>`;
  }).join('') + '<i class="fas fa-certificate2" />';
  const converted = replaceLegacyFontAwesomeIcons(source);

  iconLibrary.legacyIconNames.forEach((name) => {
    assert.match(converted, new RegExp(`class="legacy-icon legacy-icon-${name}"`));
    assert.match(converted, new RegExp(`href="#${iconLibrary.symbolId(name)}"`));
    assert.match(converted, new RegExp(`<a href="/${name}">[\\s\\S]*?<span>${name}</span></a>`));
  });
  assert.doesNotMatch(converted, /\bfa(?:s|b)\b|\bfa-[a-z0-9-]+\b/);
  assert.doesNotMatch(converted, /certificate2/);
  assert.match(converted, /aria-hidden="true" focusable="false"/);
  assert.throws(
    () => replaceLegacyFontAwesomeIcons('<i class="fas fa-unreviewed" />'),
    /Unmapped legacy Font Awesome icon: unreviewed/,
  );
  assert.throws(
    () => replaceLegacyFontAwesomeIcons('<i class="fas fa-book fa-link" />'),
    /Expected one Font Awesome icon class/,
  );
  assert.throws(
    () => replaceLegacyFontAwesomeIcons('<i class="fas fa-book">visible</i>'),
    /Unsupported Font Awesome markup/,
  );

  const embedded = '<if<i class="fas fa-certificate2" />rame src="https://example.com"></iframe>';
  const embeddedResult = replaceLegacyFontAwesomeIcons(embedded);
  assert.strictEqual(embeddedResult, embedded);
  assert.strictEqual(
    collectHtmlElements(embeddedResult, { fragment: true })
      .filter((element) => element.tagName === 'iframe').length,
    0,
  );
});

test('converts every Font Awesome reference in the published issue corpus', () => {
  const reader = openReadOnly(path.join(__dirname, '../content/public.sqlite'));
  const content = new StaticPublicContent(reader);
  const convertedNames = new Set();
  let sourceContainsMalformedCertificate = false;
  let sourceIconCount = 0;

  content.getPublishedMagazines().forEach((magazine) => {
    const issue = content.getIssue(magazine.index);
    sourceIconCount += Object.values(issue.pages).reduce((total, html) => (
      total + (html.match(
        /<i\b[^>]*\bclass\s*=\s*(?:"[^"]*\b(?:fas|fab)\b[^"]*"|'[^']*\b(?:fas|fab)\b[^']*')[^>]*>/gi,
      ) || []).length
    ), 0);
    sourceContainsMalformedCertificate = sourceContainsMalformedCertificate
      || Object.values(issue.pages).some((html) => /fa-certificate2/.test(html));
    const prepared = content.prepareIssuePages(magazine.index, issue.pages);
    Object.values(prepared.pages).forEach((html) => {
      assert.doesNotMatch(
        html,
        /<i\b[^>]*class=(?:"[^"]*\b(?:fas|fab)\b[^"]*"|'[^']*\b(?:fas|fab)\b[^']*')/i,
      );
      assert.doesNotMatch(html, /fa-certificate2/);
      for (const match of html.matchAll(/legacy-icon-([a-z0-9-]+)/g)) {
        convertedNames.add(match[1]);
      }
    });
  });
  reader.close();

  assert(sourceContainsMalformedCertificate);
  assert.strictEqual(sourceIconCount, 270);
  assert.deepStrictEqual(
    [...convertedNames].sort(),
    [...iconLibrary.legacyIconNames].sort(),
  );
});

test('loads icons inline without Font Awesome or Material Icons stylesheets', () => {
  const template = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/index.html'),
    'utf8',
  );
  const allNames = new Set([
    ...iconLibrary.toolbarIconNames,
    ...iconLibrary.legacyIconNames,
    ...iconLibrary.audioIconNames,
  ]);

  assert.strictEqual(Object.keys(iconLibrary.icons).length, 21);
  assert.strictEqual(allNames.size, 21);
  assert.doesNotMatch(template, /font-awesome|fontawesome|Material\+Icons/i);
});

test('adds isolated development rendering without changing production templates', () => {
  const source = `<!doctype html><html><head>
    <script>if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/service-worker.js'); }</script>
    <script async src="https://www.googletagmanager.com/gtag/js?id=test"></script>
    <script>window.dataLayer = []; function gtag(){} gtag('config', 'test');</script>
  </head><body></body></html>`;
  const rendered = renderDevelopmentDocument(source, 'generation-test');
  assert.match(rendered, /name="robots" content="noindex, nofollow"/);
  assert.match(rendered, /id="galata-development-config" type="application\/json"/);
  assert.match(rendered, /generation-test/);
  assert.match(rendered, /src="\/__dev\/runtime\.js" defer/);
  assert.doesNotMatch(rendered, /galataDevelopmentRuntime|\/__dev\/status/);
  assert.strictEqual(DEVELOPMENT_RUNTIME_PATH, '/__dev/runtime.js');
  assert.match(DEVELOPMENT_RUNTIME_SOURCE, /galataDevelopmentRuntime/);
  assert.match(DEVELOPMENT_RUNTIME_SOURCE, /\/__dev\/status/);
  assert.match(DEVELOPMENT_RUNTIME_SOURCE, /status\.server !== observedServer/);
  assert.doesNotMatch(
    rendered,
    /googletagmanager|serviceWorker\.register\(/,
  );
  assert.match(source, /googletagmanager/);
});

test('removes development scripts by parsed identity and preserves unrelated scripts', () => {
  const source = `<!doctype html><html><head>
    <meta name="robots" content="noindex">
    <script data-keep="true">window.dataLayer = []; gtag('config', 'keep');</script>
    <script defer src="https:&#47;&#47;www.googletagmanager.com/gtag/js?id=test"></script >
    <script>if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/service-worker.js'); } <script>alert(1)</script >tail</script>
  </head><body>unchanged</body></html>`;
  const rendered = renderDevelopmentDocument(source, 'parsed-generation');

  assert.match(
    rendered,
    /<script data-keep="true">window\.dataLayer = \[\]; gtag\('config', 'keep'\);<\/script>/,
  );
  assert.doesNotMatch(rendered, /googletagmanager|serviceWorker\.register|<script>alert\(1\)/);
  assert.match(rendered, /tail/);
  assert.match(rendered, /<body>unchanged<\/body>/);
  assert.throws(
    () => renderDevelopmentDocument(
      '<html><head><script>if (\'serviceWorker\' in navigator) { navigator.serviceWorker.register(\'/service-worker.js\'); }',
      'generation',
    ),
    /without an explicit closing tag/,
  );
});

test('keeps generator production defaults and requires a development token', () => {
  const production = parseGeneratorOptions([]);
  assert.strictEqual(production.mode, 'production');
  assert.match(production.output, /internal[/\\]site[/\\]dist$/);
  assert.throws(
    () => parseGeneratorOptions(['--mode', 'development']),
    /generation-token/,
  );
  const development = parseGeneratorOptions([
    '--mode', 'development',
    '--output', 'build/dev-test',
    '--base-url', 'http://127.0.0.1:3000/',
    '--generation-token', 'token',
  ]);
  assert.strictEqual(development.baseUrl, 'http://127.0.0.1:3000');
  assert.strictEqual(development.generationToken, 'token');
});

test('preserves the complete legacy audio-player corpus as structured data', () => {
  const reader = openReadOnly(path.join(__dirname, '../content/public.sqlite'));
  const content = new StaticPublicContent(reader);
  let groups = 0;
  let tracks = 0;
  let legacyOnlyTracks = 0;
  const genericTeamTracks = [];

  content.getPublishedMagazines().forEach((magazine) => {
    const issue = content.getIssue(magazine.index);
    const prepared = content.prepareIssuePages(magazine.index, issue.pages);
    Object.entries(prepared.audioPlayers).forEach(([pageNumber, players]) => {
      assert.strictEqual(players.length, 1);
      assert.strictEqual(
        (prepared.pages[pageNumber].match(/data-audio-player-id=/g) || []).length,
        1,
      );
      assert.doesNotMatch(
        prepared.pages[pageNumber],
        /player_songs|\binitPlayer\s*\(|\bstartPlayer\s*\(|\son(?:click|mousedown|mousemove|mouseout)=|<audio\b/i,
      );
      groups += players.length;
      players.forEach((player) => {
        tracks += player.tracks.length;
        legacyOnlyTracks += player.tracks.filter((track) => !track.recitationId).length;
        assert.strictEqual(new Set(player.tracks.map((track) => track.id)).size, player.tracks.length);
        player.tracks.forEach((track) => {
          assert.deepStrictEqual(track.sources.map((source) => source.type), ['audio/mpeg']);
          assert.match(track.sources[0].src, /\.mp3(?:$|[?#])/i);
          if (normalizeText(track.reader)
            === normalizeText('Galata Dergisi Ses Makinesi Ekibi')) {
            assert.deepStrictEqual(track.reciterLinks, []);
            genericTeamTracks.push(
              `${magazine.index}:${Number(pageNumber)}:${track.title}`,
            );
          }
        });
      });
    });
  });

  const issue46 = content.prepareIssuePages(46, content.getIssue(46).pages);
  const [issue46Track] = issue46.audioPlayers[58][0].tracks;
  const issue12 = content.prepareIssuePages(12, content.getIssue(12).pages);
  const [ordinaryLinkedTrack] = issue12.audioPlayers[33][0].tracks;
  const issue46Recitation = content.recitations.find(
    (recitation) => recitation.mp3Path === '/magazines/sayi46/audio/dinleti.mp3',
  );
  assert.strictEqual(issue46Track.reader, 'Galata Dergisi Ses Makinesi Ekibi');
  assert.deepStrictEqual(issue46Track.reciterLinks, []);
  assert.match(
    issue46.pages[58],
    /<div class="song_artist"[^>]*>Galata Dergisi Ses Makinesi Ekibi<\/div>/,
  );
  assert.strictEqual(issue46Recitation.contributors.length, 7);
  issue46Recitation.contributors.forEach((contributor) => {
    assert(
      content.getContributorProfile(contributor.id).recitations
        .some((recitation) => recitation.id === issue46Recitation.id),
    );
  });
  assert.deepStrictEqual(ordinaryLinkedTrack.reciterLinks, [{
    name: 'Ozan Ceyhan Türülken',
    href: '/katkida-bulunanlar/27-ozan-ceyhan-turulken',
  }]);
  reader.close();

  assert.strictEqual(groups, 45);
  assert.strictEqual(tracks, 237);
  assert.strictEqual(legacyOnlyTracks, 19);
  assert.deepStrictEqual(genericTeamTracks, [
    '46:58:“Geçtiğimiz Altı Ayda Çok Şey Oldu” Şiir Dinletisi',
    '45:34:“Kapı” Şiir Dinletisi',
    '42:43:“Sarı Kağıtlar ve Hatıralar” Şiir Dinletisi',
    '34:27:Sahte Pelerin',
    '34:27:Bir Fasit Daire',
  ]);
});

test('publishes only MP3 while preserving malformed and duplicate legacy inputs', () => {
  const html = `
    <script>startPlayer(); initPlayer();</script>
    <input name="player_songs" size="1" id="Aynı" value="Okuyan" class="/audio/a.mp3">
    <input name="player_songs" size="1" id="Aynı" value="Okuyan" class="/audio/a.mp3">
    <input name="player_songs" size="1" id="Tek" value="Başka" class="/audio/b.mp3">
    <input name="player_songs" size="2" id="Yanlış başlık" value="Yanlış okuyan" class="/audio/a.ogg">
    <audio id="player"></audio>
    <div id="show_time"><div></div></div>
    <div class="player_container"><div></div></div>`;
  const result = transformAudioPlayerPage(html, {
    issue: 99,
    pageNumber: 7,
    playerOrdinal: 1,
    recitations: [{
      mp3Path: '/audio/b.mp3',
      oggPath: '/audio/b.ogg',
      anchorId: 'kayit-b',
    }],
  });

  assert.strictEqual(result.players[0].tracks.length, 3);
  assert.deepStrictEqual(
    result.players[0].tracks.map((track) => track.sources.map((source) => source.src)),
    [
      ['/audio/a.mp3'],
      ['/audio/a.mp3'],
      ['/audio/b.mp3'],
    ],
  );
  assert.strictEqual(result.players[0].tracks[2].recitationId, 'kayit-b');
  assert.doesNotMatch(result.html, /player_songs|startPlayer|initPlayer|<audio\b|onclick=/i);
  assert.strictEqual((result.html.match(/<button\b/g) || []).length, 4);
  assert.strictEqual((result.html.match(/type="range"/g) || []).length, 2);
  assert.match(result.html, /aria-label="Oynat"/);
  assert.match(result.html, /aria-label="Önceki kayıt"/);
  assert.match(result.html, /aria-label="Sonraki kayıt"/);
  assert.match(result.html, /aria-label="Sesi kapat"/);
  assert.match(result.html, /aria-label="Kayıtta ilerle"/);
  assert.match(result.html, /aria-label="Ses düzeyi"/);
  ['audio-previous', 'audio-next', 'audio-play', 'audio-volume-high']
    .forEach((name) => {
      assert.match(result.html, new RegExp(`href="#${iconLibrary.symbolId(name)}"`));
    });
});

test('removes parsed legacy audio scripts without revealing nested script tokens', () => {
  const html = `
    before
    <script>startPlayer(); <script>alert(1)</script >tail</script>
    <script data-keep="true">console.log('keep');</script>
    <input name="player_songs" size="1" id="Track" value="Reader" class="/audio/a.mp3">
    <audio id="player"></audio>
    <div id="show_time"><div></div></div>
    <div class="player_container"><div></div></div>
    after`;
  const result = transformAudioPlayerPage(html, {
    issue: 99,
    pageNumber: 8,
    playerOrdinal: 1,
    recitations: [],
  });

  assert.match(result.html, /before/);
  assert.match(result.html, /after/);
  assert.match(result.html, /tail/);
  assert.match(result.html, /<script data-keep="true">console\.log\('keep'\);<\/script>/);
  assert.doesNotMatch(result.html, /startPlayer|<script>alert\(1\)/);

  assert.throws(
    () => transformAudioPlayerPage(`
      <script>startPlayer();
      <input name="player_songs" size="1" id="Track" value="Reader" class="/audio/a.mp3">
      <div class="player_container"></div>`, {
      issue: 99,
      pageNumber: 9,
      playerOrdinal: 1,
      recitations: [],
    }),
    /without an explicit closing tag/,
  );
});

test('preserves the generic team credit as unlinked player text only', () => {
  const html = `
    <input name="player_songs" size="1" id="Dinleti" value="Galata Dergisi Ses Makinesi Ekibi" class="/audio/dinleti.mp3" data-recitation-id="ses-46" data-reciter-links='[{"name":"Ada Yazar","url":"/katkida-bulunanlar/1-ada-yazar"}]'>
    <input name="player_songs" size="2" id="Dinleti" value="Galata Dergisi Ses Makinesi Ekibi" class="/audio/dinleti.ogg">
    <div class="player_container"><div></div></div>`;
  const result = transformAudioPlayerPage(html, {
    issue: 46,
    pageNumber: 58,
    playerOrdinal: 1,
    recitations: [],
  });
  const [track] = result.players[0].tracks;

  assert.strictEqual(track.reader, 'Galata Dergisi Ses Makinesi Ekibi');
  assert.deepStrictEqual(track.reciterLinks, []);
  assert.deepStrictEqual(track.sources, [{ src: '/audio/dinleti.mp3', type: 'audio/mpeg' }]);
  assert.match(
    result.html,
    /<div class="song_artist"[^>]*>Galata Dergisi Ses Makinesi Ekibi<\/div>/,
  );
  assert.doesNotMatch(
    result.html,
    /<div class="song_artist"[^>]*><a class="contributor-link"/,
  );
});

test('keeps the audio player compact while improving status and control accessibility', () => {
  const styles = fs.readFileSync(
    path.join(__dirname, '../client/styles/audio-player.scss'),
    'utf8',
  );
  const component = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/components/AudioPlayer.svelte'),
    'utf8',
  );
  assert.match(styles, /\.player_container\s*\{[\s\S]*?width:\s*435px;[\s\S]*?height:\s*100px;/);
  assert.match(styles, /\.song_name,[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/);
  assert.match(styles, /\.song_name,\s*#song_name\s*\{[^}]*padding-right:\s*64px;/);
  assert.match(styles, /\.song_artist,\s*#song_artist\s*\{[^}]*padding-right:\s*64px;/);
  assert.match(styles, /\.player_track_navigation\s*\{[\s\S]*?top:\s*calc\(50% - 4px\);/);
  assert.match(styles, /\.player_track_navigation\s*\{[\s\S]*?right:\s*4px;/);
  assert.match(styles, /\.player_track_navigation\s*\{[\s\S]*?display:\s*flex;[\s\S]*?gap:\s*4px;/);
  assert.match(styles, /\.player_next,[\s\S]*?\.player_previous\s*\{[\s\S]*?height:\s*24px;[\s\S]*?width:\s*24px;/);
  assert.match(styles, /\.player_status_error\s*\{[\s\S]*?color:\s*#ffb3b3;/);
  assert.match(styles, /button:focus-visible/);
  assert.match(styles, /input:focus-visible/);
  assert.match(component, /data-page-turn-gesture-boundary/);
  assert.doesNotMatch(
    component,
    /stopPageTurnGesture|isolatePageTurnGestures|addEventListener\(['"](?:mouse|touch)|on(?:mouse|touch)(?:start|move|end)|preventDefault\(/,
  );
  const serverContent = fs.readFileSync(
    path.join(__dirname, '../scripts/lib/audio-player-content.js'),
    'utf8',
  );
  assert.match(serverContent, /data-page-turn-gesture-boundary/);
  assert.match(component, /aria-busy=\{playerState\.waiting \? 'true' : 'false'\}/);
  assert.match(component, /playerState\.waiting \? 'Yükleniyor…' : ''/);
  assert.match(component, /role="status"[\s\S]*aria-live="polite"[\s\S]*aria-atomic="true"/);
  assert.match(component, /aria-valuetext=\{seekValueText\}/);
  assert.ok(
    component.indexOf('class="player_previous"') < component.indexOf('class="player_next"'),
    'Previous must precede Next in DOM and keyboard focus order',
  );
  assert.match(component, /onpointermove=\{updateTooltip\}/);
  assert.match(component, /\{#each bufferedSegments as segment \(segment\.left\)\}/);
  assert.match(component, /left: \$\{segment\.left\}px; width: \$\{segment\.width\}px/);
  assert.doesNotMatch(
    styles,
    /\.show_time,\s*#show_time\s*\{[^}]*display:\s*none/s,
  );
  assert.match(styles, /\.show_time\[hidden\],[\s\S]*display:\s*none/);
  assert.doesNotMatch(component, /player_sr_status/);
  assert.doesNotMatch(component, />\s*(?:Süre|Parça listesi|Durum)\s*</i);
  assert.match(component, /name="audio-previous"/);
  assert.match(component, /name="audio-next"/);
  assert.match(component, /name=\{playbackActive \? 'audio-pause' : 'audio-play'\}/);
  assert.match(component, /name=\{volumeIconName\}/);
  assert.doesNotMatch(
    `${styles}\n${component}\n${serverContent}`,
    /legacy-player-icons|volume_(?:max|med|min|mute)/,
  );
  const assetSources = [
    '../scripts/generate-site.js',
    '../scripts/lib/shell-assets.js',
  ].map((filename) => fs.readFileSync(path.join(__dirname, filename), 'utf8')).join('\n');
  assert.doesNotMatch(assetSources, /legacy-player-icons/);
  assert(!fs.existsSync(path.join(
    __dirname,
    '../client/images/legacy-player-icons',
  )));
  const controller = fs.readFileSync(
    path.join(__dirname, '../client/lib/audio-player-controller.mjs'),
    'utf8',
  );
  assert.doesNotMatch(controller, /canPlayType|nextSourceIndex|activeSourceIndex/);
});

test('models audio-player boundaries, formatting, buffering, and volume icons', async () => {
  const {
    bufferedRanges,
    clamp,
    formatTime,
    nextTrackIndex,
    previousTrackIndex,
    progressRatio,
    volumeIcon,
  } = await audioPlayerStateModule;
  assert.strictEqual(clamp(-1, 0, 1), 0);
  assert.strictEqual(clamp(2, 0, 1), 1);
  assert.strictEqual(formatTime(123.9), '02:03');
  assert.strictEqual(progressRatio(25, 100), 0.25);
  assert.strictEqual(progressRatio(5, 0), 0);
  const ranges = bufferedRanges({
    length: 6,
    start(index) {
      if (index === 2) throw new Error('bad start');
      return [0, 8, 10, -1, 30, 50][index];
    },
    end(index) {
      if (index === 4) throw new Error('bad end');
      return [2, 21, 15, 5, 40, 49][index];
    },
  });
  assert.deepStrictEqual(ranges, [{ start: 0, end: 2 }, { start: 8, end: 21 }]);
  assert.deepStrictEqual(bufferedRanges({
    get length() { throw new Error('bad length'); },
  }), []);
  assert.strictEqual(nextTrackIndex(2, 3), 0);
  assert.strictEqual(nextTrackIndex(2, 3, true), null);
  assert.strictEqual(previousTrackIndex(0, 3), 2);
  assert.strictEqual(nextTrackIndex(0, 1), null);
  assert.strictEqual(volumeIcon(1, false), 'audio-volume-high');
  assert.strictEqual(volumeIcon(0.5, false), 'audio-volume-medium');
  assert.strictEqual(volumeIcon(0.1, false), 'audio-volume-low');
  assert.strictEqual(volumeIcon(1, true), 'audio-volume-muted');
});

test('keeps the selected track and MP3 source synchronized across manual switches', async () => {
  class FakeAudio extends EventTarget {
    constructor() {
      super();
      this.currentTime = 0;
      this.duration = 0;
      this.volume = 1;
      this.muted = false;
      this.src = '';
      this.currentSrc = '';
      this.preload = '';
      this.paused = true;
      this.ended = false;
      this.error = null;
      this.HAVE_NOTHING = 0;
      this.HAVE_METADATA = 1;
      this.HAVE_CURRENT_DATA = 2;
      this.HAVE_FUTURE_DATA = 3;
      this.HAVE_ENOUGH_DATA = 4;
      this.readyState = this.HAVE_NOTHING;
      this.playCalls = 0;
      this.pauseCalls = 0;
      this.buffered = { length: 0, start: () => 0, end: () => 0 };
    }

    load() {
      this.currentSrc = this.src;
      this.currentTime = 0;
      this.readyState = this.HAVE_METADATA;
      this.ended = false;
      this.error = null;
    }
    play() {
      this.playCalls += 1;
      this.paused = false;
      this.ended = false;
      this.readyState = this.HAVE_ENOUGH_DATA;
      this.dispatchEvent(new Event('play'));
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    }

    pause() {
      this.pauseCalls += 1;
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    }

    removeAttribute(name) {
      if (name === 'src') {
        this.src = '';
        this.currentSrc = '';
      }
    }
  }

  const tracks = [
    { id: 'first', recitationId: 'first-anchor', sources: [{ src: '/first.mp3', type: 'audio/mpeg' }] },
    { id: 'second', recitationId: 'second-anchor', sources: [{ src: '/second.mp3', type: 'audio/mpeg' }] },
    { id: 'third', recitationId: 'third-anchor', sources: [{ src: '/third.mp3', type: 'audio/mpeg' }] },
  ];
  const { createAudioPlayerController } = await audioPlayerControllerModule;

  const unplayedAudio = new FakeAudio();
  const unplayedChanges = [];
  const unplayedController = createAudioPlayerController([{ id: 'unplayed', tracks }], {
    audio: unplayedAudio,
    onTrackChange: (change) => unplayedChanges.push(change),
  });
  await unplayedController.next('unplayed');
  assert.strictEqual(unplayedController.getState('unplayed').selectedIndex, 1);
  assert.strictEqual(unplayedAudio.src, '');
  await unplayedController.selectTrack('unplayed', 1, { play: true });
  assert.strictEqual(unplayedAudio.src, '/second.mp3');
  assert.strictEqual(unplayedAudio.currentTime, 0);
  assert.strictEqual(unplayedController.getState('unplayed').selectedIndex, 1);
  assert.strictEqual(unplayedChanges.at(-1).track.recitationId, 'second-anchor');
  assert.strictEqual(unplayedChanges.at(-1).updateHash, true);

  unplayedAudio.duration = 100;
  unplayedAudio.currentTime = 23;
  unplayedAudio.dispatchEvent(new Event('timeupdate'));
  const stateBeforeSameHash = unplayedController.getState('unplayed');
  const playCallsBeforeSameHash = unplayedAudio.playCalls;
  const pauseCallsBeforeSameHash = unplayedAudio.pauseCalls;
  assert.deepStrictEqual(
    unplayedController.selectHash('#second-anchor'),
    { playerId: 'unplayed', trackIndex: 1 },
  );
  assert.deepStrictEqual(unplayedController.getState('unplayed'), stateBeforeSameHash);
  assert.strictEqual(unplayedAudio.playCalls, playCallsBeforeSameHash);
  assert.strictEqual(unplayedAudio.pauseCalls, pauseCallsBeforeSameHash);
  assert.strictEqual(unplayedChanges.at(-1).reason, 'hash');
  assert.strictEqual(unplayedChanges.at(-1).updateHash, false);

  await unplayedController.selectTrack('unplayed', 1, { play: true });
  assert.strictEqual(unplayedAudio.playCalls, playCallsBeforeSameHash);
  assert.strictEqual(unplayedAudio.pauseCalls, pauseCallsBeforeSameHash);
  unplayedController.destroy();

  const seekedAudio = new FakeAudio();
  const seekedController = createAudioPlayerController([{ id: 'seeked', tracks }], {
    audio: seekedAudio,
  });
  await seekedController.play('seeked');
  seekedAudio.duration = 1535;
  seekedAudio.dispatchEvent(new Event('durationchange'));
  seekedController.seek('seeked', 1380);
  assert.strictEqual(seekedAudio.currentTime, 1380);
  await seekedController.next('seeked');
  assert.strictEqual(seekedController.getState('seeked').selectedIndex, 1);
  assert.strictEqual(seekedController.getState('seeked').currentTime, 0);
  assert.strictEqual(seekedAudio.src, '/second.mp3');
  assert.strictEqual(seekedAudio.currentTime, 0);
  seekedController.destroy();
});

test('preserves pending playback intent across track changes and lets toggle cancel it', async () => {
  class PendingAudio extends EventTarget {
    constructor() {
      super();
      this.currentTime = 0;
      this.duration = 100;
      this.volume = 1;
      this.muted = false;
      this.src = '';
      this.currentSrc = '';
      this.preload = '';
      this.paused = true;
      this.ended = false;
      this.error = null;
      this.HAVE_NOTHING = 0;
      this.HAVE_METADATA = 1;
      this.HAVE_CURRENT_DATA = 2;
      this.HAVE_FUTURE_DATA = 3;
      this.HAVE_ENOUGH_DATA = 4;
      this.readyState = this.HAVE_NOTHING;
      this.buffered = { length: 0, start: () => 0, end: () => 0 };
      this.playCalls = 0;
      this.pauseCalls = 0;
    }

    load() {
      this.currentSrc = this.src;
      this.currentTime = 0;
      this.readyState = this.HAVE_METADATA;
      this.ended = false;
      this.error = null;
    }
    play() {
      this.playCalls += 1;
      this.paused = false;
      this.ended = false;
      this.readyState = this.HAVE_CURRENT_DATA;
      return Promise.resolve();
    }

    pause() {
      this.pauseCalls += 1;
      this.paused = true;
    }

    removeAttribute(name) {
      if (name === 'src') {
        this.src = '';
        this.currentSrc = '';
      }
    }
  }

  const audio = new PendingAudio();
  const tracks = [
    { id: 'first', sources: [{ src: '/first.mp3', type: 'audio/mpeg' }] },
    { id: 'second', sources: [{ src: '/second.mp3', type: 'audio/mpeg' }] },
  ];
  const { createAudioPlayerController } = await audioPlayerControllerModule;
  const controller = createAudioPlayerController([{ id: 'pending', tracks }], { audio });

  await controller.play('pending');
  assert.strictEqual(controller.getState('pending').waiting, true);
  await controller.next('pending');
  assert.strictEqual(controller.getState('pending').selectedIndex, 1);
  assert.strictEqual(controller.getState('pending').waiting, true);
  assert.strictEqual(audio.src, '/second.mp3');
  assert.strictEqual(audio.playCalls, 2);
  audio.dispatchEvent(new Event('pause'));
  assert.strictEqual(controller.getState('pending').waiting, true);

  const secondSource = audio.currentSrc;
  audio.currentSrc = '/first.mp3';
  audio.currentTime = 87;
  audio.duration = 999;
  audio.readyState = audio.HAVE_ENOUGH_DATA;
  for (const event of [
    'play',
    'playing',
    'waiting',
    'timeupdate',
    'durationchange',
    'loadedmetadata',
    'canplay',
    'seeked',
  ]) {
    audio.dispatchEvent(new Event(event));
  }
  assert.strictEqual(controller.getState('pending').playing, false);
  assert.strictEqual(controller.getState('pending').waiting, true);
  assert.strictEqual(controller.getState('pending').currentTime, 0);
  assert.strictEqual(controller.getState('pending').duration, 0);
  audio.currentSrc = secondSource;
  audio.currentTime = 0;
  audio.duration = 100;

  await controller.previous('pending');
  assert.strictEqual(controller.getState('pending').selectedIndex, 0);
  assert.strictEqual(audio.src, '/first.mp3');
  assert.strictEqual(audio.playCalls, 3);

  audio.dispatchEvent(new Event('play'));
  assert.strictEqual(controller.getState('pending').playing, false);
  assert.strictEqual(controller.getState('pending').waiting, true);
  audio.dispatchEvent(new Event('playing'));
  assert.strictEqual(controller.getState('pending').playing, false);
  assert.strictEqual(controller.getState('pending').waiting, true);
  audio.readyState = audio.HAVE_FUTURE_DATA;
  audio.dispatchEvent(new Event('playing'));
  assert.strictEqual(controller.getState('pending').playing, true);
  assert.strictEqual(controller.getState('pending').waiting, false);
  audio.readyState = audio.HAVE_ENOUGH_DATA;
  audio.dispatchEvent(new Event('waiting'));
  assert.strictEqual(controller.getState('pending').waiting, false);
  audio.readyState = audio.HAVE_CURRENT_DATA;
  audio.dispatchEvent(new Event('waiting'));
  assert.strictEqual(controller.getState('pending').waiting, true);
  audio.readyState = audio.HAVE_FUTURE_DATA;
  audio.dispatchEvent(new Event('playing'));
  assert.strictEqual(controller.getState('pending').waiting, false);

  await controller.play('pending');
  const playCallsBeforeToggle = audio.playCalls;
  await controller.toggle('pending');
  assert.strictEqual(audio.playCalls, playCallsBeforeToggle);
  assert.strictEqual(controller.getState('pending').playing, false);
  assert.strictEqual(controller.getState('pending').waiting, false);

  for (const event of ['play', 'waiting', 'playing']) {
    audio.dispatchEvent(new Event(event));
    assert.strictEqual(controller.getState('pending').playing, false);
    assert.strictEqual(controller.getState('pending').waiting, false);
  }

  await controller.selectTrack('pending', 0, { play: true });
  assert.strictEqual(controller.getState('pending').waiting, true);
  audio.dispatchEvent(new Event('error'));
  assert.strictEqual(controller.getState('pending').waiting, true);
  assert.strictEqual(controller.getState('pending').error, '');
  audio.error = { code: 4 };
  audio.paused = true;
  audio.dispatchEvent(new Event('error'));
  assert.strictEqual(controller.getState('pending').playing, false);
  assert.strictEqual(controller.getState('pending').waiting, false);
  assert.match(controller.getState('pending').error, /yüklenemedi/);
  audio.paused = false;
  audio.dispatchEvent(new Event('playing'));
  assert.strictEqual(controller.getState('pending').playing, false);
  assert.match(controller.getState('pending').error, /yüklenemedi/);
  controller.destroy();
});

test('bounds stalled audio startup and retries with preserved player state', async () => {
  class StalledAudio extends EventTarget {
    constructor() {
      super();
      this._currentTime = 0;
      this.duration = 120;
      this.volume = 1;
      this.muted = false;
      this.src = '';
      this.currentSrc = '';
      this.preload = '';
      this.paused = true;
      this.ended = false;
      this.error = null;
      this.HAVE_METADATA = 1;
      this.HAVE_CURRENT_DATA = 2;
      this.HAVE_FUTURE_DATA = 3;
      this.readyState = 0;
      this.buffered = { length: 0, start: () => 0, end: () => 0 };
      this.loadCalls = 0;
      this.pauseCalls = 0;
      this.playCalls = 0;
      this.playResolvers = [];
      this.autoPlay = false;
      this.blockPositiveSeek = false;
    }

    get currentTime() {
      return this._currentTime;
    }

    set currentTime(value) {
      const nextTime = Number(value);
      if (this.blockPositiveSeek && nextTime > 0) {
        throw new Error('metadata is not ready');
      }
      this._currentTime = nextTime;
    }

    load() {
      this.loadCalls += 1;
      this.currentSrc = this.src;
      this._currentTime = 0;
      this.readyState = this.HAVE_METADATA;
      this.ended = false;
      this.error = null;
    }

    play() {
      this.playCalls += 1;
      this.paused = false;
      this.ended = false;
      if (this.autoPlay) {
        this.readyState = this.HAVE_FUTURE_DATA;
        this.dispatchEvent(new Event('play'));
        this.dispatchEvent(new Event('playing'));
        return Promise.resolve();
      }
      return new Promise((resolve) => this.playResolvers.push(resolve));
    }

    pause() {
      this.pauseCalls += 1;
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    }

    removeAttribute(name) {
      if (name === 'src') {
        this.src = '';
        this.currentSrc = '';
      }
    }
  }

  const timers = createManualTimers();
  const audio = new StalledAudio();
  const tracks = [{
    id: 'bounded-track',
    sources: [{ src: '/bounded.mp3', type: 'audio/mpeg' }],
  }];
  const { createAudioPlayerController } = await audioPlayerControllerModule;
  const controller = createAudioPlayerController([{ id: 'bounded', tracks }], {
    audio,
    playbackTimeoutMs: 10_000,
    timers,
  });

  const initialPlay = controller.play('bounded');
  controller.setVolume('bounded', 0.4);
  controller.setMuted('bounded', true);
  audio.currentTime = 37;
  audio.dispatchEvent(new Event('timeupdate'));
  assert.strictEqual(controller.getState('bounded').waiting, true);
  assert.strictEqual(timers.pendingCount(), 1);

  assert.strictEqual(timers.fire(10_000), true);
  assert.strictEqual(await initialPlay, false);
  assert.strictEqual(timers.pendingCount(), 0);
  assert.strictEqual(audio.src, '');
  assert.strictEqual(audio.loadCalls, 2);
  assert.strictEqual(controller.getState('bounded').currentTime, 37);
  assert.strictEqual(controller.getState('bounded').playing, false);
  assert.strictEqual(controller.getState('bounded').waiting, false);
  assert.match(controller.getState('bounded').error, /yüklenemedi/);

  audio.playResolvers[0]();
  await Promise.resolve();
  audio.currentSrc = '/bounded.mp3';
  audio.paused = false;
  audio.readyState = audio.HAVE_FUTURE_DATA;
  audio.dispatchEvent(new Event('playing'));
  assert.strictEqual(controller.getState('bounded').playing, false);
  assert.match(controller.getState('bounded').error, /yüklenemedi/);

  audio.autoPlay = true;
  audio.blockPositiveSeek = true;
  assert.strictEqual(await controller.play('bounded'), true);
  assert.strictEqual(audio.loadCalls, 3);
  assert.strictEqual(audio.currentTime, 0);
  assert.strictEqual(audio.volume, 0.4);
  assert.strictEqual(audio.muted, true);
  assert.strictEqual(timers.pendingCount(), 0);

  audio.blockPositiveSeek = false;
  audio.dispatchEvent(new Event('loadedmetadata'));
  assert.strictEqual(audio.currentTime, 37);
  assert.strictEqual(controller.getState('bounded').currentTime, 37);
  assert.strictEqual(controller.getState('bounded').playing, true);
  assert.strictEqual(controller.getState('bounded').error, '');
  controller.destroy();
});

test('bounds rebuffering without extending or leaking playback deadlines', async () => {
  class BufferingAudio extends EventTarget {
    constructor() {
      super();
      this.currentTime = 0;
      this.duration = 100;
      this.volume = 1;
      this.muted = false;
      this.src = '';
      this.currentSrc = '';
      this.preload = '';
      this.paused = true;
      this.ended = false;
      this.error = null;
      this.HAVE_METADATA = 1;
      this.HAVE_CURRENT_DATA = 2;
      this.HAVE_FUTURE_DATA = 3;
      this.readyState = 0;
      this.buffered = { length: 0, start: () => 0, end: () => 0 };
      this.loadCalls = 0;
    }

    load() {
      this.loadCalls += 1;
      this.currentSrc = this.src;
      this.currentTime = 0;
      this.readyState = this.HAVE_METADATA;
      this.ended = false;
      this.error = null;
    }

    play() {
      this.paused = false;
      this.ended = false;
      this.readyState = this.HAVE_FUTURE_DATA;
      this.dispatchEvent(new Event('play'));
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    }

    pause() {
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    }

    removeAttribute(name) {
      if (name === 'src') {
        this.src = '';
        this.currentSrc = '';
      }
    }
  }

  const timers = createManualTimers();
  const audio = new BufferingAudio();
  const tracks = [
    { id: 'first', sources: [{ src: '/first.mp3', type: 'audio/mpeg' }] },
    { id: 'second', sources: [{ src: '/second.mp3', type: 'audio/mpeg' }] },
  ];
  const { createAudioPlayerController } = await audioPlayerControllerModule;
  const controller = createAudioPlayerController([{ id: 'buffering', tracks }], {
    audio,
    playbackTimeoutMs: 10_000,
    timers,
  });

  assert.strictEqual(await controller.play('buffering'), true);
  assert.strictEqual(timers.pendingCount(), 0);
  audio.currentTime = 51;
  audio.readyState = audio.HAVE_CURRENT_DATA;
  audio.dispatchEvent(new Event('waiting'));
  const deadlinesBeforeRepeat = timers.setCount();
  audio.dispatchEvent(new Event('waiting'));
  assert.strictEqual(timers.setCount(), deadlinesBeforeRepeat);
  assert.strictEqual(timers.pendingCount(), 1);

  assert.strictEqual(timers.fire(10_000), true);
  assert.strictEqual(controller.getState('buffering').currentTime, 51);
  assert.strictEqual(controller.getState('buffering').waiting, false);
  assert.match(controller.getState('buffering').error, /yüklenemedi/);
  assert.strictEqual(timers.pendingCount(), 0);

  assert.strictEqual(await controller.play('buffering'), true);
  audio.readyState = audio.HAVE_CURRENT_DATA;
  audio.dispatchEvent(new Event('waiting'));
  assert.strictEqual(timers.pendingCount(), 1);
  controller.pause('buffering');
  assert.strictEqual(timers.pendingCount(), 0);

  assert.strictEqual(await controller.play('buffering'), true);
  audio.readyState = audio.HAVE_CURRENT_DATA;
  audio.dispatchEvent(new Event('waiting'));
  assert.strictEqual(timers.pendingCount(), 1);
  assert.strictEqual(await controller.next('buffering'), true);
  assert.strictEqual(controller.getState('buffering').selectedIndex, 1);
  assert.strictEqual(timers.pendingCount(), 0);

  audio.readyState = audio.HAVE_CURRENT_DATA;
  audio.dispatchEvent(new Event('waiting'));
  audio.error = { code: 2 };
  audio.dispatchEvent(new Event('error'));
  assert.strictEqual(timers.pendingCount(), 0);

  assert.strictEqual(await controller.play('buffering'), true);
  audio.readyState = audio.HAVE_CURRENT_DATA;
  audio.dispatchEvent(new Event('waiting'));
  audio.currentTime = audio.duration;
  audio.ended = true;
  audio.paused = true;
  audio.dispatchEvent(new Event('ended'));
  assert.strictEqual(timers.pendingCount(), 0);

  assert.strictEqual(await controller.play('buffering'), true);
  audio.readyState = audio.HAVE_CURRENT_DATA;
  audio.dispatchEvent(new Event('waiting'));
  assert.strictEqual(timers.pendingCount(), 1);
  controller.destroy();
  assert.strictEqual(timers.pendingCount(), 0);
});

test('reloads genuine media errors from the saved position without reloading play rejection', async () => {
  class RetryAudio extends EventTarget {
    constructor() {
      super();
      this._currentTime = 0;
      this.duration = 120;
      this.volume = 1;
      this.muted = false;
      this.src = '';
      this.currentSrc = '';
      this.preload = '';
      this.paused = true;
      this.ended = false;
      this.error = null;
      this.HAVE_NOTHING = 0;
      this.HAVE_METADATA = 1;
      this.HAVE_CURRENT_DATA = 2;
      this.HAVE_FUTURE_DATA = 3;
      this.HAVE_ENOUGH_DATA = 4;
      this.readyState = this.HAVE_NOTHING;
      this.buffered = { length: 0, start: () => 0, end: () => 0 };
      this.loadCalls = 0;
      this.playCalls = 0;
      this.rejectPlay = false;
      this.blockPositiveSeek = false;
    }

    get currentTime() {
      return this._currentTime;
    }

    set currentTime(value) {
      const nextTime = Number(value);
      if (this.blockPositiveSeek && nextTime > 0) {
        throw new Error('metadata is not ready');
      }
      this._currentTime = nextTime;
    }

    load() {
      this.loadCalls += 1;
      this.currentSrc = this.src;
      this.currentTime = 0;
      this.readyState = this.HAVE_METADATA;
      this.ended = false;
      this.error = null;
    }

    play() {
      this.playCalls += 1;
      if (this.rejectPlay) return Promise.reject(new Error('blocked'));
      this.paused = false;
      this.ended = false;
      this.readyState = this.HAVE_ENOUGH_DATA;
      this.dispatchEvent(new Event('play'));
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    }

    pause() {
      const wasPaused = this.paused;
      this.paused = true;
      if (!wasPaused) this.dispatchEvent(new Event('pause'));
    }

    removeAttribute(name) {
      if (name === 'src') {
        this.src = '';
        this.currentSrc = '';
      }
    }
  }

  const audio = new RetryAudio();
  const tracks = [{ id: 'retry-track', sources: [{ src: '/retry.mp3', type: 'audio/mpeg' }] }];
  const { createAudioPlayerController } = await audioPlayerControllerModule;
  const controller = createAudioPlayerController([{ id: 'retry', tracks }], { audio });

  await controller.play('retry');
  controller.setVolume('retry', 0.4);
  controller.setMuted('retry', true);
  audio.currentTime = 37;
  audio.dispatchEvent(new Event('timeupdate'));
  audio.error = { code: 2 };
  audio.currentTime = 0;
  audio.dispatchEvent(new Event('timeupdate'));
  audio.paused = true;
  audio.readyState = audio.HAVE_CURRENT_DATA;
  audio.dispatchEvent(new Event('error'));
  assert.match(controller.getState('retry').error, /yüklenemedi/);
  assert.strictEqual(controller.getState('retry').currentTime, 37);

  const loadsBeforeErrorRetry = audio.loadCalls;
  audio.blockPositiveSeek = true;
  assert.strictEqual(await controller.play('retry'), true);
  assert.strictEqual(audio.loadCalls, loadsBeforeErrorRetry + 1);
  assert.strictEqual(audio.currentTime, 0);
  audio.blockPositiveSeek = false;
  audio.dispatchEvent(new Event('loadedmetadata'));
  assert.strictEqual(audio.currentTime, 37);
  assert.strictEqual(audio.volume, 0.4);
  assert.strictEqual(audio.muted, true);
  assert.strictEqual(controller.getState('retry').playing, true);
  assert.strictEqual(controller.getState('retry').error, '');

  controller.pause('retry');
  audio.rejectPlay = true;
  const loadsBeforeRejectedPlay = audio.loadCalls;
  assert.strictEqual(await controller.play('retry'), false);
  assert.strictEqual(audio.loadCalls, loadsBeforeRejectedPlay);
  assert.match(controller.getState('retry').error, /oynatılamadı/);

  audio.rejectPlay = false;
  assert.strictEqual(await controller.play('retry'), true);
  assert.strictEqual(audio.loadCalls, loadsBeforeRejectedPlay);
  assert.strictEqual(controller.getState('retry').playing, true);
  controller.destroy();
});

test('advances only within a fixed end tolerance for long recordings', async () => {
  class LongAudio extends EventTarget {
    constructor() {
      super();
      this.currentTime = 0;
      this.duration = 1535;
      this.volume = 1;
      this.muted = false;
      this.src = '';
      this.currentSrc = '';
      this.preload = '';
      this.paused = true;
      this.ended = false;
      this.error = null;
      this.HAVE_NOTHING = 0;
      this.HAVE_METADATA = 1;
      this.HAVE_CURRENT_DATA = 2;
      this.HAVE_FUTURE_DATA = 3;
      this.HAVE_ENOUGH_DATA = 4;
      this.readyState = this.HAVE_NOTHING;
      this.buffered = { length: 0, start: () => 0, end: () => 0 };
      this.loadCalls = 0;
      this.playCalls = 0;
    }

    get currentTime() {
      return this._currentTime;
    }

    set currentTime(value) {
      this._currentTime = Number(value);
      if (this.ended && this._currentTime < this.duration) this.ended = false;
    }

    load() {
      this.loadCalls += 1;
      this.currentSrc = this.src;
      this.currentTime = 0;
      this.readyState = this.HAVE_METADATA;
      this.ended = false;
      this.error = null;
    }
    play() {
      this.playCalls += 1;
      if (this.ended) this.currentTime = 0;
      this.paused = false;
      this.ended = false;
      this.readyState = this.HAVE_ENOUGH_DATA;
      this.dispatchEvent(new Event('play'));
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    }

    pause() {
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    }

    finishNaturally() {
      this.currentTime = this.duration;
      this.ended = true;
      this.paused = true;
      this.dispatchEvent(new Event('timeupdate'));
      this.dispatchEvent(new Event('pause'));
      this.dispatchEvent(new Event('ended'));
    }

    removeAttribute(name) {
      if (name === 'src') {
        this.src = '';
        this.currentSrc = '';
      }
    }
  }

  const audio = new LongAudio();
  const tracks = [
    { id: 'first', sources: [{ src: '/first.mp3', type: 'audio/mpeg' }] },
    { id: 'second', sources: [{ src: '/second.mp3', type: 'audio/mpeg' }] },
  ];
  const { createAudioPlayerController } = await audioPlayerControllerModule;
  const controller = createAudioPlayerController([{ id: 'long', tracks }], { audio });

  await controller.play('long');
  controller.pause('long');
  audio.currentTime = audio.duration;
  audio.ended = true;
  audio.dispatchEvent(new Event('ended'));
  await Promise.resolve();
  assert.strictEqual(controller.getState('long').selectedIndex, 0);
  assert.strictEqual(controller.getState('long').playing, false);

  audio.ended = false;
  audio.currentTime = 0;
  await controller.play('long');
  audio.currentTime = audio.duration;
  audio.ended = true;
  audio.error = { code: 2 };
  audio.dispatchEvent(new Event('ended'));
  await Promise.resolve();
  assert.strictEqual(controller.getState('long').selectedIndex, 0);
  assert.strictEqual(controller.getState('long').playing, true);

  audio.error = null;
  audio.ended = false;
  audio.currentTime = 0;
  audio.currentTime = audio.duration;
  audio.dispatchEvent(new Event('ended'));
  await Promise.resolve();
  assert.strictEqual(controller.getState('long').selectedIndex, 0);
  assert.strictEqual(controller.getState('long').playing, true);

  audio.currentTime = audio.duration - 1;
  audio.ended = true;
  audio.dispatchEvent(new Event('ended'));
  await Promise.resolve();
  assert.strictEqual(controller.getState('long').selectedIndex, 0);
  assert.strictEqual(controller.getState('long').playing, true);

  const sourceBeforePrematureEnd = audio.currentSrc;
  const loadsBeforePrematureEnd = audio.loadCalls;
  const playsBeforePrematureEnd = audio.playCalls;
  audio.currentTime = audio.duration - 1;
  audio.ended = true;
  audio.paused = true;
  audio.dispatchEvent(new Event('pause'));
  audio.dispatchEvent(new Event('ended'));
  await Promise.resolve();
  assert.strictEqual(controller.getState('long').selectedIndex, 0);
  assert.strictEqual(controller.getState('long').currentTime, audio.duration - 1);
  assert.strictEqual(controller.getState('long').playing, false);
  assert.strictEqual(controller.getState('long').waiting, false);
  assert.strictEqual(controller.getState('long').error, '');
  assert.strictEqual(audio.currentSrc, sourceBeforePrematureEnd);
  assert.strictEqual(audio.loadCalls, loadsBeforePrematureEnd);
  assert.strictEqual(audio.playCalls, playsBeforePrematureEnd);

  await controller.toggle('long');
  assert.strictEqual(controller.getState('long').selectedIndex, 0);
  assert.strictEqual(controller.getState('long').playing, true);
  assert.strictEqual(controller.getState('long').currentTime, audio.duration - 1);
  assert.strictEqual(audio.currentTime, audio.duration - 1);
  assert.strictEqual(audio.ended, false);
  assert.strictEqual(audio.currentSrc, sourceBeforePrematureEnd);
  assert.strictEqual(audio.loadCalls, loadsBeforePrematureEnd);
  assert.strictEqual(audio.playCalls, playsBeforePrematureEnd + 1);

  audio.currentTime = audio.duration - 2;
  audio.ended = true;
  audio.paused = true;
  audio.dispatchEvent(new Event('pause'));
  audio.dispatchEvent(new Event('ended'));
  await Promise.resolve();
  assert.strictEqual(controller.getState('long').currentTime, audio.duration - 2);
  assert.strictEqual(controller.getState('long').playing, false);

  const userSeekPosition = 600;
  controller.seek('long', userSeekPosition);
  assert.strictEqual(controller.getState('long').currentTime, userSeekPosition);
  assert.strictEqual(audio.currentTime, userSeekPosition);
  await controller.toggle('long');
  assert.strictEqual(controller.getState('long').selectedIndex, 0);
  assert.strictEqual(controller.getState('long').playing, true);
  assert.strictEqual(controller.getState('long').currentTime, userSeekPosition);
  assert.strictEqual(audio.currentTime, userSeekPosition);
  assert.strictEqual(audio.currentSrc, sourceBeforePrematureEnd);
  assert.strictEqual(audio.loadCalls, loadsBeforePrematureEnd);
  assert.strictEqual(audio.playCalls, playsBeforePrematureEnd + 2);

  audio.ended = false;
  audio.finishNaturally();
  await Promise.resolve();
  assert.strictEqual(controller.getState('long').selectedIndex, 1);
  assert.strictEqual(controller.getState('long').playing, true);

  audio.finishNaturally();
  await Promise.resolve();
  assert.strictEqual(controller.getState('long').selectedIndex, 1);
  assert.strictEqual(controller.getState('long').playing, false);
  controller.destroy();
});

test('refreshes disjoint buffered ranges on media state events and clears them for new sources', async () => {
  class FakeAudio extends EventTarget {
    constructor() {
      super();
      this.currentTime = 0;
      this.duration = 100;
      this.volume = 1;
      this.muted = false;
      this.src = '';
      this.currentSrc = '';
      this.preload = '';
      this.paused = true;
      this.ended = false;
      this.error = null;
      this.HAVE_NOTHING = 0;
      this.HAVE_METADATA = 1;
      this.HAVE_CURRENT_DATA = 2;
      this.HAVE_FUTURE_DATA = 3;
      this.HAVE_ENOUGH_DATA = 4;
      this.readyState = this.HAVE_NOTHING;
      this.buffered = this.ranges([]);
    }

    ranges(intervals) {
      return {
        length: intervals.length,
        start: (index) => intervals[index][0],
        end: (index) => intervals[index][1],
      };
    }

    load() {
      this.currentSrc = this.src;
      this.currentTime = 0;
      this.readyState = this.HAVE_METADATA;
      this.ended = false;
      this.error = null;
    }
    play() {
      this.paused = false;
      this.ended = false;
      this.readyState = this.HAVE_ENOUGH_DATA;
      this.dispatchEvent(new Event('play'));
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    }

    pause() {
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    }

    removeAttribute(name) {
      if (name === 'src') {
        this.src = '';
        this.currentSrc = '';
      }
    }
  }

  const fakeAudio = new FakeAudio();
  const tracks = [
    { id: 'first', sources: [{ src: '/first.mp3', type: 'audio/mpeg' }] },
    { id: 'second', sources: [{ src: '/second.mp3', type: 'audio/mpeg' }] },
  ];
  const { createAudioPlayerController } = await audioPlayerControllerModule;
  const controller = createAudioPlayerController([{ id: 'buffered', tracks }], {
    audio: fakeAudio,
  });

  await controller.play('buffered');
  fakeAudio.buffered = fakeAudio.ranges([[0, 12], [45, 52]]);
  fakeAudio.currentTime = 7;
  fakeAudio.dispatchEvent(new Event('timeupdate'));
  assert.deepStrictEqual(controller.getState('buffered').bufferedRanges, [
    { start: 0, end: 12 },
    { start: 45, end: 52 },
  ]);

  fakeAudio.buffered = fakeAudio.ranges([[6, 18], [70, 80]]);
  for (const event of ['durationchange', 'loadedmetadata', 'canplay', 'seeked', 'progress']) {
    fakeAudio.dispatchEvent(new Event(event));
    assert.deepStrictEqual(controller.getState('buffered').bufferedRanges, [
      { start: 6, end: 18 },
      { start: 70, end: 80 },
    ]);
  }

  const snapshot = controller.getState('buffered');
  snapshot.bufferedRanges[0].end = 99;
  assert.equal(controller.getState('buffered').bufferedRanges[0].end, 18);

  await controller.next('buffered');
  assert.equal(fakeAudio.src, '/second.mp3');
  assert.deepStrictEqual(controller.getState('buffered').bufferedRanges, []);
  controller.destroy();
});

test('coordinates playback, wrapping, natural completion, switching, and disposal', async () => {
  class FakeAudio extends EventTarget {
    constructor() {
      super();
      this.currentTime = 0;
      this.duration = 100;
      this.volume = 1;
      this.muted = false;
      this.src = '';
      this.currentSrc = '';
      this.preload = '';
      this.paused = true;
      this.ended = false;
      this.error = null;
      this.HAVE_NOTHING = 0;
      this.HAVE_METADATA = 1;
      this.HAVE_CURRENT_DATA = 2;
      this.HAVE_FUTURE_DATA = 3;
      this.HAVE_ENOUGH_DATA = 4;
      this.readyState = this.HAVE_NOTHING;
      this.buffered = { length: 1, start: () => 0, end: () => 40 };
      this.playCalls = 0;
      this.pauseCalls = 0;
      this.rejectPlay = false;
      this.removedSource = false;
    }

    canPlayType() { return 'probably'; }
    load() {
      this.currentSrc = this.src;
      this.currentTime = 0;
      this.readyState = this.HAVE_METADATA;
      this.ended = false;
      this.error = null;
    }
    play() {
      this.playCalls += 1;
      if (this.rejectPlay) return Promise.reject(new Error('blocked'));
      this.paused = false;
      this.ended = false;
      this.readyState = this.HAVE_ENOUGH_DATA;
      this.dispatchEvent(new Event('play'));
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    }

    pause() {
      this.pauseCalls += 1;
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    }

    removeAttribute(name) {
      if (name === 'src') {
        this.src = '';
        this.currentSrc = '';
        this.removedSource = true;
      }
    }
  }

  const fakeAudio = new FakeAudio();
  const changes = [];
  const players = {
    2: [{
      id: 'one',
      tracks: [
        { id: 'one-a', recitationId: 'anchor-a', sources: [{ src: '/a.mp3', type: 'audio/mpeg' }] },
        { id: 'one-b', recitationId: 'anchor-b', sources: [{ src: '/b.mp3', type: 'audio/mpeg' }] },
      ],
    }],
    4: [{
      id: 'two',
      tracks: [{ id: 'two-a', recitationId: null, sources: [{ src: '/c.mp3', type: 'audio/mpeg' }] }],
    }],
  };
  const { createAudioPlayerController } = await audioPlayerControllerModule;
  const controller = createAudioPlayerController(players, {
    audio: fakeAudio,
    onTrackChange: (change) => changes.push(change),
  });

  assert.deepStrictEqual(controller.selectHash('#anchor-b'), { playerId: 'one', trackIndex: 1 });
  assert.strictEqual(controller.getState('one').playing, false);
  await controller.play('one');
  const detachedViewStates = [];
  const detachView = controller.subscribe('one', (state) => detachedViewStates.push(state));
  detachView();
  fakeAudio.currentTime = 37;
  fakeAudio.dispatchEvent(new Event('timeupdate'));
  let remountedState = null;
  const detachRemountedView = controller.subscribe('one', (state) => {
    remountedState = state;
  });
  detachRemountedView();
  assert.strictEqual(remountedState.currentTime, 37);
  assert.strictEqual(remountedState.playing, true);
  await controller.next('one');
  assert.strictEqual(controller.getState('one').selectedIndex, 0);
  assert.strictEqual(controller.getState('one').playing, true);
  fakeAudio.currentTime = 18;
  await controller.play('two');
  assert.strictEqual(controller.getState('one').playing, false);
  assert.strictEqual(controller.getState('one').currentTime, 18);
  assert.strictEqual(controller.getState('two').playing, true);

  await controller.selectTrack('one', 1, { play: true });
  controller.seek('one', 75);
  fakeAudio.dispatchEvent(new Event('ended'));
  await Promise.resolve();
  assert.strictEqual(controller.getState('one').selectedIndex, 1);
  assert.strictEqual(controller.getState('one').currentTime, 75);
  assert.strictEqual(controller.getState('one').playing, true);

  fakeAudio.currentTime = fakeAudio.duration;
  fakeAudio.ended = true;
  fakeAudio.paused = true;
  fakeAudio.dispatchEvent(new Event('pause'));
  fakeAudio.dispatchEvent(new Event('ended'));
  await Promise.resolve();
  assert.strictEqual(controller.getState('one').selectedIndex, 1);
  assert.strictEqual(controller.getState('one').playing, false);
  assert(changes.some((change) => change.track.recitationId === 'anchor-b'));

  fakeAudio.dispatchEvent(new Event('error'));
  assert.strictEqual(controller.getState('one').error, '');
  fakeAudio.error = { code: 4 };
  fakeAudio.dispatchEvent(new Event('error'));
  assert.strictEqual(controller.getState('one').playing, false);
  assert.strictEqual(controller.getState('one').waiting, false);
  assert.match(controller.getState('one').error, /yüklenemedi/);

  fakeAudio.rejectPlay = true;
  assert.strictEqual(await controller.play('two'), false);
  assert.strictEqual(controller.getState('two').playing, false);
  assert.strictEqual(controller.getState('two').waiting, false);
  assert.match(controller.getState('two').error, /oynatılamadı/);
  const unsubscribeAfterDestroy = controller.subscribe('two', () => {});
  controller.destroy();
  assert.doesNotThrow(() => unsubscribeAfterDestroy());
  assert.doesNotThrow(() => unsubscribeAfterDestroy());
  assert.strictEqual(controller.getState('two').playing, false);
  assert.strictEqual(controller.getState('two').waiting, false);
  assert.strictEqual(fakeAudio.removedSource, true);
});

test('renders only the visible carousel window before buffering', async () => {
  const {
    beginCarouselMove,
    createCarouselState,
    getCarouselWindow,
  } = await carouselStateModule;

  for (let length = 0; length <= 3; length += 1) {
    const items = Array.from({ length }, (_, index) => ({ index }));
    const state = createCarouselState(items);
    const window = getCarouselWindow(items, state, false);
    assert.strictEqual(window.startIndex, 0);
    assert.strictEqual(state.targetFirstItemIndex, 0);
    assert.strictEqual(beginCarouselMove(state, 1, 0, items), state);
    assert.deepStrictEqual(
      window.entries.map((entry) => entry.index),
      items.map((_, index) => index),
    );
    assert(window.entries.every((entry) => entry.visible));
  }

  const items = Array.from({ length: 46 }, (_, index) => ({ index }));
  const state = createCarouselState(items);
  assert.deepStrictEqual(
    getCarouselWindow(items, state, false).entries.map((entry) => entry.index),
    [0, 1, 2],
  );
  assert.deepStrictEqual(
    getCarouselWindow(items, state, true).entries.map((entry) => entry.index),
    [0, 1, 2, 3],
  );
});

test('models carousel movement and buffering', async () => {
  const {
    beginCarouselMove,
    createCarouselState,
    finishCarouselMove,
    getCarouselWindow,
  } = await carouselStateModule;
  const items = Array.from({ length: 46 }, (_, index) => ({ index }));
  const initial = createCarouselState(items);
  const movingRight = beginCarouselMove(initial, 1, 0, items);

  assert.deepStrictEqual(movingRight, {
    sourceFirstItemPosition: 0,
    targetFirstItemIndex: 1,
    animating: true,
  });

  const movingWindow = getCarouselWindow(items, movingRight, true);
  assert.deepStrictEqual(
    movingWindow.entries.map((entry) => entry.index),
    [0, 1, 2, 3, 4],
  );
  assert.deepStrictEqual(
    movingWindow.entries.filter((entry) => entry.visible).map((entry) => entry.index),
    [0, 1, 2, 3],
  );
  assert.strictEqual(movingWindow.entries[0].motion, 'out');
  assert.strictEqual(movingWindow.entries[3].motion, 'in');

  const settledRight = finishCarouselMove(movingRight, items);
  assert.deepStrictEqual(
    getCarouselWindow(items, settledRight, true).entries
      .filter((entry) => entry.visible)
      .map((entry) => entry.index),
    [1, 2, 3],
  );

  const movingLeft = beginCarouselMove(settledRight, -1, 1, items);
  assert.deepStrictEqual(movingLeft, {
    sourceFirstItemPosition: 1,
    targetFirstItemIndex: 0,
    animating: true,
  });
  assert.deepStrictEqual(
    getCarouselWindow(items, movingLeft, false).entries.map((entry) => entry.index),
    [0, 1, 2, 3],
  );
});

test('bounds rapid carousel input from fractional positions', async () => {
  const {
    beginCarouselMove,
    createCarouselState,
    finishCarouselMove,
    getCarouselWindow,
  } = await carouselStateModule;
  const items = Array.from({ length: 46 }, (_, index) => ({ index }));
  const initial = createCarouselState(items);
  let state = initial;
  let previousIndexes = getCarouselWindow(items, initial, true).entries
    .map((entry) => entry.index);

  for (let press = 0; press < 5; press += 1) {
    state = beginCarouselMove(state, 1, 0, items);
    const indexes = getCarouselWindow(items, state, true).entries
      .map((entry) => entry.index);
    const newlyWindowed = indexes.filter((index) => !previousIndexes.includes(index));
    assert.strictEqual(newlyWindowed.length, 1);
    previousIndexes = indexes;
  }

  assert.deepStrictEqual(state, {
    sourceFirstItemPosition: 2,
    targetFirstItemIndex: 5,
    animating: true,
  });
  assert.deepStrictEqual(
    getCarouselWindow(items, state, true).entries.map((entry) => entry.index),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.deepStrictEqual(finishCarouselMove(state, items), {
    sourceFirstItemPosition: 5,
    targetFirstItemIndex: 5,
    animating: false,
  });

  let mixedState = beginCarouselMove(initial, 1, 0, items);
  mixedState = beginCarouselMove(mixedState, 1, 0.35, items);
  assert.deepStrictEqual(mixedState, {
    sourceFirstItemPosition: 0.35,
    targetFirstItemIndex: 2,
    animating: true,
  });
  const interruptedWindow = getCarouselWindow(items, mixedState, true);
  assert.deepStrictEqual(
    interruptedWindow.entries.map((entry) => entry.index),
    [0, 1, 2, 3, 4, 5],
  );
  assert.deepStrictEqual(
    interruptedWindow.entries.filter((entry) => entry.visible).map((entry) => entry.index),
    [0, 1, 2, 3, 4],
  );
  assert.deepStrictEqual(
    interruptedWindow.entries.filter((entry) => entry.motion === 'out')
      .map((entry) => entry.index),
    [0, 1],
  );
  assert.deepStrictEqual(
    interruptedWindow.entries.filter((entry) => entry.motion === 'in')
      .map((entry) => entry.index),
    [4],
  );

  mixedState = beginCarouselMove(mixedState, -1, 0.8, items);
  assert.strictEqual(mixedState.sourceFirstItemPosition, 0.8);
  assert.strictEqual(mixedState.targetFirstItemIndex, 1);
  assert.deepStrictEqual(finishCarouselMove(mixedState, items), {
    sourceFirstItemPosition: 1,
    targetFirstItemIndex: 1,
    animating: false,
  });

  let boundaryState = initial;
  for (let press = 0; press < 100; press += 1) {
    boundaryState = beginCarouselMove(boundaryState, 1, 0, items);
  }
  assert.strictEqual(boundaryState.sourceFirstItemPosition, 40);
  assert.strictEqual(boundaryState.targetFirstItemIndex, 43);
  assert.strictEqual(beginCarouselMove(boundaryState, 1, 0, items), boundaryState);
  assert.deepStrictEqual(
    getCarouselWindow(items, boundaryState, true).entries.map((entry) => entry.index),
    [39, 40, 41, 42, 43, 44, 45],
  );
});

test('clamps carousel boundaries and resets motion when items change', async () => {
  const {
    beginCarouselMove,
    createCarouselState,
    finishCarouselMove,
    getCarouselWindow,
    reconcileCarouselState,
  } = await carouselStateModule;
  const items = Array.from({ length: 46 }, (_, index) => ({ index }));
  let state = createCarouselState(items);

  for (let index = 0; index < 43; index += 1) {
    state = finishCarouselMove(
      beginCarouselMove(state, 1, state.targetFirstItemIndex, items),
      items,
    );
  }
  assert.strictEqual(state.sourceFirstItemPosition, 43);
  assert.strictEqual(state.targetFirstItemIndex, 43);
  assert.strictEqual(beginCarouselMove(state, 1, 43, items), state);
  assert.deepStrictEqual(
    getCarouselWindow(items, state, true).entries.map((entry) => entry.index),
    [42, 43, 44, 45],
  );

  for (let index = 0; index < 43; index += 1) {
    state = finishCarouselMove(
      beginCarouselMove(state, -1, state.targetFirstItemIndex, items),
      items,
    );
  }
  assert.strictEqual(state.sourceFirstItemPosition, 0);
  assert.strictEqual(state.targetFirstItemIndex, 0);
  assert.strictEqual(beginCarouselMove(state, -1, 0, items), state);

  let moving = beginCarouselMove(state, 1, 0, items);
  moving = beginCarouselMove(moving, 1, 0.3, items);
  moving = beginCarouselMove(moving, 1, 0.9, items);
  const replacement = [{ index: 1 }, { index: 0 }];
  const reconciled = reconcileCarouselState(moving, replacement);
  assert.deepStrictEqual(reconciled, {
    sourceFirstItemPosition: 0,
    targetFirstItemIndex: 0,
    animating: false,
  });
  assert.deepStrictEqual(
    getCarouselWindow(replacement, reconciled, true).entries.map((entry) => entry.index),
    [0, 1],
  );
});

test('uses a design-aligned keyboard focus indicator for carousel arrows', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/components/Arrow.svelte'),
    'utf8',
  );

  assert.match(source, /button:focus-visible polygon\s*\{/);
  assert.match(source, /stroke:\s*rgba\(105, 129, 69, 0\.6\)/);
  assert.match(source, /stroke-linejoin:\s*round/);
  assert.match(source, /@media \(forced-colors: active\)/);
  assert.match(source, /stroke:\s*Highlight/);
  assert.doesNotMatch(source, /\bbutton\s*\{[^}]*outline:\s*none/s);
});

test('makes the faded homepage carousel inaccessible while an issue is open', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/HomePage.svelte'),
    'utf8',
  );

  // `inert` is a boolean HTML attribute, so inert="false" is still inert.
  // The inactive homepage must omit it instead of stringifying false.
  assert.match(source, /inert=\{loadedMagazine \? true : undefined\}/);
  assert.doesNotMatch(source, /inert=\{Boolean\(loadedMagazine\)\}/);
  assert.doesNotMatch(source, /aria-hidden=\{loadedMagazine/);
  assert.match(source, /homepageContainer\?\.contains\(document\.activeElement\)/);
  assert.match(source, /focusedHomepageElement\?\.blur\(\)/);
  assert.match(source, /querySelector\('\.toolbar \.close-icon'\)\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /\.container\.hidden\s*\{[^}]*pointer-events:\s*none/s);
});

test('restores keyboard focus to the cover that opened the reader', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/HomePage.svelte'),
    'utf8',
  );

  assert.match(source, /if \(focusedHomepageElement\) magazineReturnFocusElement = focusedHomepageElement/);
  assert.match(source, /await unloadMagazine\(\{ restoreFocus: false \}\)/);
  assert.match(source, /async function onMagazineOutroEnd\(\)/);
  assert.match(source, /if \(shouldRestoreFocus\)[\s\S]*await tick\(\)/);
  assert.match(source, /returnFocusElement\.focus\(\{ preventScroll: true \}\)/);
});

test('keeps the latest reader navigation authoritative during the outro', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/HomePage.svelte'),
    'utf8',
  );

  assert.match(source, /createReaderTransitionCoordinator/);
  assert.match(source, /const navigationSequence = readerTransition\.beginNavigation\(\)/);
  assert.match(
    source,
    /await unloadMagazine\(\{ restoreFocus: false \}\);\s*if \(!readerTransition\.isCurrentNavigation\(navigationSequence\)\) return false/,
  );
  assert.match(source, /readerTransition\.beginOutro\([\s\S]*\{ restoreFocus \}\)/);
  assert.match(source, /readerTransition\.finishOutro\(\)/);
  assert.match(source, /readerTransition\.hasPendingOutro\(\)/);
  assert.match(source, /onUnloadMagazine=\{requestMagazineUnload\}/);
  assert.doesNotMatch(source, /window\.location\.assign\('[/]'\)/);
});

test('prevents disabled carousel arrows from selecting content behind them', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/components/Arrow.svelte'),
    'utf8',
  );

  assert.match(source, /<button[\s\S]*type="button"[\s\S]*\{disabled\}/);
  assert.match(source, /Dergi listesini sağa kaydır/);
  assert.match(source, /Dergi listesini sola kaydır/);
  assert.match(source, /title=\{navigationLabel\}/);
  assert.match(source, /aria-label=\{navigationLabel\}/);
  assert.doesNotMatch(source, /Slide carousel/);
  assert.match(source, /onpointerdown=\{handlePointerDown\}/);
  assert.match(source, /if \(disabled\) event\.preventDefault\(\)/);
  assert.match(source, /user-select:\s*none/);
  assert.match(source, /button\s*\{[^}]*height:\s*100%[^}]*width:\s*100%/s);
  assert.match(source, /svg\s*\{[^}]*height:\s*100%[^}]*width:\s*100%/s);
  assert.doesNotMatch(source, /pointer-events:\s*none/);
});

test('keeps an outgoing carousel cover transparent until it is hidden', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/components/MagazineThumbnail.svelte'),
    'utf8',
  );

  assert.match(source, /a\.fade-out\s*\{[^}]*animation:\s*fade-out \.3s ease forwards/s);
});

test('defers newly windowed cover images until carousel movement settles', () => {
  const carousel = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/components/Carousel.svelte'),
    'utf8',
  );
  const thumbnail = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/components/MagazineThumbnail.svelte'),
    'utf8',
  );

  assert.match(carousel, /deferImage=\{carouselState\.animating\}/);
  assert.match(thumbnail, /let imageEnabled = \$state\(false\)/);
  assert.match(thumbnail, /let shouldRenderImage = \$derived\(imageEnabled \|\| !deferImage\)/);
  assert.match(thumbnail, /if \(!deferImage\) imageEnabled = true/);
  assert.match(thumbnail, /\{#if shouldRenderImage\}\s*<picture>/);
});

test('shows keyboard focus on magazine covers', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/components/MagazineThumbnail.svelte'),
    'utf8',
  );

  assert.match(source, /a:focus-visible\s*\{[^}]*outline-color:\s*#698145/s);
  assert.match(source, /@media \(forced-colors: active\)/);
  assert.doesNotMatch(source, /outline:\s*none\s*!important/);
});

test('keeps reader navigation inert until the page-turn engine is ready', () => {
  const homePage = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/HomePage.svelte'),
    'utf8',
  );
  const magazine = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/components/Magazine.svelte'),
    'utf8',
  );

  assert.match(
    homePage,
    /if \(loadedMagazine && loadedMagazine\.index === index && loadedMagazineSvelteInstance\) \{\s*return loadedMagazineSvelteInstance\.goToPage\(page, hash, historyAction\)/,
  );
  assert.match(homePage, /if \(loadedMagazineSvelteInstance\) \{[\s\S]*goToPreviousPage\(\)/);
  assert.match(homePage, /if \(loadedMagazineSvelteInstance\) \{[\s\S]*goToNextPage\(\)/);
  assert.match(homePage, /shouldHandleDirectionalNavigation\(e\)/);
  assert.match(magazine, /let readerReady = \$state\(false\)/);
  assert.match(magazine, /pageTurn = new PageTurn[\s\S]*readerReady = true/);
  assert.match(magazine, /if \(!readerReady \|\| !pageTurn\) return false/);
  assert.match(magazine, /aria-disabled=\{previousNavigationDisabled \? 'true' : undefined\}/);
  assert.match(magazine, /aria-disabled=\{!readerReady \? 'true' : undefined\}/);
  assert.match(magazine, /aria-disabled=\{nextNavigationDisabled \? 'true' : undefined\}/);
  assert.match(magazine, /tabindex=\{previousNavigationDisabled \? -1 : undefined\}/);
  assert.match(magazine, /tabindex=\{nextNavigationDisabled \? -1 : undefined\}/);
});

test('preserves modified browser arrow shortcuts across homepage navigation', () => {
  const homePage = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/HomePage.svelte'),
    'utf8',
  );
  const arrow = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/components/Arrow.svelte'),
    'utf8',
  );

  assert.match(homePage, /import \{ shouldHandleDirectionalNavigation \}/);
  assert.match(homePage, /if \(!shouldHandleDirectionalNavigation\(e\)\) return/);
  assert.match(arrow, /import \{ shouldHandleDirectionalNavigation \}/);
  assert.match(arrow, /if \(!shouldHandleDirectionalNavigation\(event\)\) return/);
});

test('shows retryable reader feedback while client-loaded pages are unavailable', () => {
  const magazine = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/components/Magazine.svelte'),
    'utf8',
  );

  assert.match(magazine, /LOADING:\s*'loading'/);
  assert.match(magazine, /READY:\s*'ready'/);
  assert.match(magazine, /ERROR:\s*'error'/);
  assert.match(magazine, /Sayı \{index\} yükleniyor…/);
  assert.match(magazine, /role="status" aria-live="polite"/);
  assert.match(magazine, /role="alert">Dergi yüklenemedi\./);
  assert.match(magazine, />Tekrar dene<\/button>/);
  assert.match(magazine, /\.reader-load-page\s*\{[\s\S]*width:\s*500px/);
  assert.match(magazine, /&\.move-left\s*\{[\s\S]*left:\s*50%[\s\S]*translateX\(-250px\)/);
  assert.match(magazine, /fetchMagazinePages\(index, \{[\s\S]*signal: controller\.signal/);
  assert.match(magazine, /requestSequence !== pageRequestSequence/);
  assert.match(magazine, /error\?\.name === 'AbortError'/);
  assert.match(magazine, /function close\(\) \{[\s\S]*cancelPendingRequests\(\)/);
  assert.match(magazine, /readerIssueFallbackTitle\(index, publishDateText\)/);
  assert.doesNotMatch(magazine, /alert\('Dergi yüklenirken/);
});

test('closes the reader without waiting for homepage SEO metadata', () => {
  const magazine = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/components/Magazine.svelte'),
    'utf8',
  );

  assert.match(magazine, /applyOptionalHomeSeoDocument\(document, seoIndex\?\.home\)/);
  assert.match(
    magazine,
    /goToHomepage[\s\S]*navigationSequence \+= 1[\s\S]*updateReaderHistory[\s\S]*onUnloadMagazine\(\)/,
  );
  assert.doesNotMatch(magazine, /window\.location\.assign\('\/'\)/);
});

test('keeps reader routes functional without issue SEO metadata', () => {
  const magazine = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/components/Magazine.svelte'),
    'utf8',
  );

  assert.match(magazine, /function commitFallbackRoute\(/);
  assert.match(
    magazine,
    /commitFallbackRoute\(page, hash, sequence, historyAction\);[\s\S]*seoIndexPromise\.then/,
  );
  assert.match(magazine, /readerIssueRoute\(index, page, hash\)/);
  assert.match(magazine, /readerIssueFallbackTitle\(index, publishDateText\)/);
  assert.doesNotMatch(magazine, /ownsInitialDocument|window\.location\.assign/);
});

test('cancels bounded page and SEO requests during reader teardown', () => {
  const homePage = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/HomePage.svelte'),
    'utf8',
  );
  const magazine = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/components/Magazine.svelte'),
    'utf8',
  );

  assert.match(magazine, /loadIssueSeo\(index, \{ signal: controller\.signal \}\)/);
  assert.match(
    magazine,
    /export function cancelPendingRequests\(\) \{\s*cancelPageRequest\(\);\s*cancelSeoRequest\(\);/,
  );
  assert.match(magazine, /error\?\.name !== 'AbortError'/);
  assert.match(homePage, /loadedMagazineSvelteInstance\.cancelPendingRequests\(\)/);
});

test('centers both covers on initial render and completed page turns', () => {
  const magazine = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/components/Magazine.svelte'),
    'utf8',
  );

  assert.match(
    magazine,
    /let moveLeft = \$state\(shouldCenterSinglePage\([\s\S]*initialState\.numberOfPages/,
  );
  assert.match(
    magazine,
    /numberOfPages = Object\.keys\(magazinePageContents\)\.length;\s*moveLeft = shouldCenterSinglePage\(currentPage, numberOfPages\);/,
  );
  assert.match(
    magazine,
    /onTurned: function\(e, page\) \{\s*moveLeft = shouldCenterSinglePage\(page, numberOfPages\);/,
  );
  assert.doesNotMatch(magazine, /\bisLoaded\b/);
});

test('coordinates page media independently from PageTurn readiness', () => {
  const magazine = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/components/Magazine.svelte'),
    'utf8',
  );

  assert.match(magazine, /createPageMediaCoordinator/);
  assert.match(magazine, /pageMediaCoordinator\.watchPage\(element, page\)/);
  assert.match(magazine, /Sayfa \{page\} yükleniyor…/);
  assert.match(magazine, /Sayfa medyası yüklenemedi\./);
  assert.match(magazine, /Tekrar dene/);
  assert.match(magazine, /pageContainsMedia\(initialPages\[page\]\)/);
  assert.match(magazine, /disposePageMedia\(\)/);
});

test('uses native Svelte 5 runes, callbacks, and component lifecycle APIs', () => {
  const componentDirectory = path.join(
    __dirname,
    '../client/pages/homepage/components',
  );
  const homePage = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/HomePage.svelte'),
    'utf8',
  );
  const carousel = fs.readFileSync(path.join(componentDirectory, 'Carousel.svelte'), 'utf8');
  const magazine = fs.readFileSync(path.join(componentDirectory, 'Magazine.svelte'), 'utf8');
  const thumbnail = fs.readFileSync(
    path.join(componentDirectory, 'MagazineThumbnail.svelte'),
    'utf8',
  );
  const entrypoint = fs.readFileSync(
    path.join(__dirname, '../client/pages/homepage/index.js'),
    'utf8',
  );
  const source = [homePage, carousel, magazine, thumbnail].join('\n');

  assert.match(source, /\$props\(\)/);
  assert.match(source, /\$state\(/);
  assert.match(source, /\$derived(?:\.by)?\(/);
  assert.doesNotMatch(source, /createEventDispatcher|svelte\/legacy|\$on\(|\$destroy\(/);
  assert.doesNotMatch(source, /\bon:[a-z]+/);
  assert.match(carousel, /onNavigate=\{\(\{ direction \}\) => move\(direction\)\}/);
  assert.match(thumbnail, /onLoadMagazine\(\{ index \}\)/);
  assert.match(magazine, /createAudioPlayerViewManager/);
  assert.match(magazine, /mount\(AudioPlayer/);
  assert.match(magazine, /unmount\(view\)/);
  assert.match(magazine, /onTurned:[\s\S]*audioPlayerViewManager\.reconcile\(\)/);
  assert.match(magazine, /disposeAudio[\s\S]*audioPlayerViewManager\.dispose\(\)/);
  assert.match(
    magazine,
    /onAudioTrackChange\(\{ player, track, updateHash \}\)[\s\S]*?!pagesShareView\(currentPage, player\.pageNumber\)[\s\S]*?scheduleSeoRoute\(\s*player\.pageNumber,/,
  );
  assert.match(magazine, /onoutroend=\{onOutroEnd\}/);
  assert.match(homePage, /onOutroEnd=\{onMagazineOutroEnd\}/);
  assert.match(entrypoint, /import \{ hydrate, mount \} from 'svelte'/);
  assert.match(entrypoint, /bootstrap\.hydratable === true \? hydrate : mount/);
  assert.match(entrypoint, /if \(!bootstrap\.hydratable\) \{\s*target\.innerHTML = '';/);
});

test('uses npm without Yarn, PnP, or a committed package cache', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../package.json'),
    'utf8',
  ));
  const dockerfile = fs.readFileSync(
    path.join(__dirname, '../ops/zap/Dockerfile'),
    'utf8',
  );

  assert.strictEqual(packageJson.packageManager, 'npm@11.16.0');
  assert.ok(fs.existsSync(path.join(__dirname, '../package-lock.json')));
  ['.yarn', '.yarnrc.yml', '.pnp.cjs', '.pnp.loader.mjs', 'yarn.lock']
    .forEach((filename) => {
      assert.ok(!fs.existsSync(path.join(__dirname, '..', filename)));
    });
  assert.match(dockerfile, /COPY package\.json package-lock\.json/);
  assert.match(dockerfile, /COPY ops\/nginx\/ ops\/nginx\//);
  assert.match(dockerfile, /RUN npm ci/);
  assert.doesNotMatch(dockerfile, /\byarn\b|corepack|\.pnp/i);
});

test('maps magazine covers onto the low-resolution placeholder sprite', async () => {
  const {
    CAROUSEL_PLACEHOLDER_ISSUE_COUNT,
    CAROUSEL_PLACEHOLDER_URL,
    getCarouselPlaceholderPosition,
  } = await carouselPlaceholderModule;
  const asset = fs.readFileSync(path.join(
    __dirname,
    '../client/images/carousel-thumbnail-placeholders.webp',
  ));

  assert.strictEqual(CAROUSEL_PLACEHOLDER_ISSUE_COUNT, 47);
  assert.strictEqual(
    CAROUSEL_PLACEHOLDER_URL,
    '/images/carousel-thumbnail-placeholders.webp',
  );
  assert.deepStrictEqual(getCarouselPlaceholderPosition(1), {
    x: -(4 * 100 / 18),
    y: -(4 * 140 / 25),
  });
  assert.deepStrictEqual(getCarouselPlaceholderPosition(47), {
    x: -((6 * 26 + 4) * 100 / 18),
    y: -((4 * 33 + 4) * 140 / 25),
  });
  assert.strictEqual(getCarouselPlaceholderPosition(0), null);
  assert.strictEqual(getCarouselPlaceholderPosition(48), null);
  assert.strictEqual(asset.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.strictEqual(asset.subarray(8, 12).toString('ascii'), 'WEBP');
  assert(asset.length < 10 * 1024, 'placeholder sprite must stay below 10 KiB');
});

test('keeps the local production preview on the production runtime boundary', () => {
  const composeSource = fs.readFileSync(
    path.join(__dirname, '../ops/local-production/compose.yaml'),
    'utf8',
  );
  const nginxDockerfile = fs.readFileSync(
    path.join(__dirname, '../ops/local-production/Dockerfile.nginx'),
    'utf8',
  );
  const smokeSource = fs.readFileSync(
    path.join(__dirname, '../scripts/test-production-preview.sh'),
    'utf8',
  );
  const previewSource = fs.readFileSync(
    path.join(__dirname, '../scripts/production-preview.sh'),
    'utf8',
  );
  const exampleSource = fs.readFileSync(
    path.join(__dirname, '../.env.example'),
    'utf8',
  );
  const gitignoreSource = fs.readFileSync(
    path.join(__dirname, '../.gitignore'),
    'utf8',
  );
  const dockerignoreSource = fs.readFileSync(
    path.join(__dirname, '../.dockerignore'),
    'utf8',
  );
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../package.json'),
    'utf8',
  ));

  assert.match(composeSource, /dockerfile: ops\/zap\/Dockerfile/);
  assert.match(composeSource, /target: scan-target/);
  assert.match(composeSource, /LISTEN_ADDR: 127\.0\.0\.1:3000/);
  assert.match(
    composeSource,
    /"127\.0\.0\.1:\$\{GALATA_PREVIEW_HTTPS_PORT:-44443\}:443"/,
  );
  assert.match(composeSource, /network_mode: service:app/);
  assert.match(composeSource, /create_host_path: false/);
  assert.match(composeSource, /target: \/var\/www\/galatadergisi\.org\/public/);
  assert.doesNotMatch(composeSource, /(?:^|["'])3000:3000(?:$|["'])/m);
  assert.match(
    nginxDockerfile,
    /COPY ops\/nginx\/galatadergisi\.org\.conf/,
  );
  assert.match(nginxDockerfile, /COPY ops\/nginx\/galata-security-headers\.conf/);
  assert.match(nginxDockerfile, /COPY ops\/nginx\/galata-production-csp\.conf/);
  assert.match(nginxDockerfile, /server_name localhost/);
  assert.match(nginxDockerfile, /nginx -t/);
  assert.doesNotMatch(nginxDockerfile, /access\.log/);
  assert.match(nginxDockerfile, /\/dev\/stderr \/var\/log\/nginx\/galatadergisi\.org\/error\.log/);
  assert.match(smokeSource, /GALATA_PREVIEW_SMOKE_HTTPS_PORT:-44444/);
  assert.match(smokeSource, /assert_status 304/);
  assert.match(smokeSource, /assert_status 206/);
  assert.match(smokeSource, /Content-Type: audio\/mpeg/);
  assert.match(smokeSource, /enforced CSP header does not match/);
  assert.match(smokeSource, /legacy video stylesheet is not externalized/);
  assert.match(smokeSource, /contributor profile script is not externalized/);
  assert.match(smokeSource, /audio response lost centralized security headers/);
  assert.match(smokeSource, /retired contribution endpoint/);
  assert.match(smokeSource, /nginx emitted an access log record/);
  assert.match(previewSource, /env_file="\$repo_root\/\.env\.production"/);
  assert.match(previewSource, /if \[ -f "\$env_file" \]/);
  assert.match(
    previewSource,
    /docker compose --env-file "\$env_file" -f "\$compose_file"/,
  );
  [
    'LISTEN_ADDR',
    'EXTERNAL_MEDIA_DIR',
    'GALATA_MEDIA_ROOT',
    'GALATA_PREVIEW_HTTPS_PORT',
  ].forEach((name) => {
    assert.match(exampleSource, new RegExp(`^${name}=`, 'm'));
  });
  assert.match(gitignoreSource, /^\.env\*$/m);
  assert.match(gitignoreSource, /^!\.env\.example$/m);
  assert.match(dockerignoreSource, /^\.env\*$/m);
  assert.strictEqual(
    packageJson.scripts.dev,
    'node --env-file-if-exists=.env.development scripts/dev.mjs',
  );
  assert.strictEqual(
    packageJson.scripts['preview:production'],
    'sh scripts/production-preview.sh up',
  );
  assert.strictEqual(
    packageJson.scripts['preview:production:down'],
    'sh scripts/production-preview.sh down',
  );
  assert.strictEqual(
    packageJson.scripts['test:production-preview'],
    'sh scripts/test-production-preview.sh',
  );
});

test('maps and aggregates development media without allowing traversal', () => {
  assert.strictEqual(
    relativeMediaPath('/images/sayi47/thumbnail.jpg'),
    'images/sayi47/thumbnail.jpg',
  );
  assert.strictEqual(
    relativeMediaPath('/magazines/sayi47/audio/reading.mp3'),
    path.join('audio', 'sayi47', 'reading.mp3'),
  );
  assert.strictEqual(relativeMediaPath('/images/../private.txt'), null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'galata-media-test-'));
  try {
    fs.mkdirSync(path.join(root, 'images', 'sayi1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'images', 'sayi1', 'thumbnail.jpg'), 'x');
    const report = inspectDevelopmentMedia(root, new Map([
      ['/images/sayi1/thumbnail.jpg', new Set(['thumbnail'])],
      ['/images/sayi2/missing.jpg', new Set(['page 1', 'page 2'])],
      ['/outside/file.jpg', new Set(['invalid'])],
    ]));
    assert.strictEqual(report.checked, 3);
    assert.deepStrictEqual(
      report.missing.map((item) => item.publicPath),
      ['/images/sayi2/missing.jpg'],
    );
    assert.deepStrictEqual(
      report.invalid.map((item) => item.publicPath),
      ['/outside/file.jpg'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('development media inventory requires MP3 but treats OGG as archival', () => {
  const reader = openReadOnly(path.join(__dirname, '../content/public.sqlite'));
  const references = collectDevelopmentMedia(reader);
  reader.close();

  assert(
    [...references.keys()].some((publicPath) => /\.mp3$/i.test(publicPath)),
  );
  assert.strictEqual(
    [...references.keys()].filter((publicPath) => /\.mp3$/i.test(publicPath)).length,
    237,
  );
  assert.strictEqual(
    [...references.keys()].some((publicPath) => /\.ogg$/i.test(publicPath)),
    false,
  );
});

test('strips parsed script and style subtrees without changing legacy entity policy', () => {
  assert.strictEqual(
    stripHtml('before<script>alert(1)</script >middle<style>hidden</style >after'),
    'before middle after',
  );
  assert.strictEqual(stripHtml('before<script>alert(1)'), 'before');
  assert.strictEqual(stripHtml('before<style>hidden'), 'before');
  assert.strictEqual(
    stripHtml('before<script>outer<script>alert(1)</script >tail</script>after'),
    'before tail after',
  );
  assert.strictEqual(stripHtml('A &amp; B &hellip; C'), 'A & B &hellip; C');
});

test('creates stable Turkish slugs and normalized names', () => {
  assert.strictEqual(slugify('  Şiir, Işık ve Öykü  '), 'siir-isik-ve-oyku');
  assert.strictEqual(normalizeText('Melis Erdoğan'), normalizeText('MELİS ERDOĞAN'));
});

test('resolves explicit contributor aliases to one canonical public identity', () => {
  assert.strictEqual(
    canonicalizeContributorName('Belif Yüksel'),
    'Büşra Elif Yüksel',
  );
  assert.strictEqual(canonicalizeContributorName('semihbnw'), 'Semih Bozkurt');
  assert.strictEqual(
    canonicalizeContributorName('Hikmet Zeynep Kazu'),
    'Zeynep Kazu',
  );
  assert.strictEqual(
    canonicalizeContributorName('Mehtap Kılıç (Aziza La’R Kuğu)'),
    'Mehtap Kılıç',
  );
  assert.strictEqual(
    canonicalizeContributorName('Aziza La’R Kuğu'),
    'Mehtap Kılıç',
  );
  assert.strictEqual(
    canonicalizeContributorName('Suat Gürbüz (Küsuratsız Pi)'),
    'Suat Gürbüz',
  );
  assert.strictEqual(
    canonicalizeContributorName('Küsuratsız Pi'),
    'Suat Gürbüz',
  );
  const recitations = extractRecitations(`
    <input name="player_songs" size="1" id="Bir Şiir"
      value="Belif Yüksel" class="/audio/belif.mp3" />
    <table>
      <tr><td>Şiir Adı:</td><td>Bir Şiir</td></tr>
      <tr><td>Okuyan:</td><td>Belif Yüksel</td></tr>
    </table>
  `);
  assert.deepStrictEqual(recitations[0].reciters, ['Büşra Elif Yüksel']);
  assert.strictEqual(
    recitations[0].warnings.some((warning) => warning.startsWith('Player credit')),
    false,
  );
});

test('keeps retired contributor typos out of content and aliases', () => {
  const retiredNames = [
    'Defne Hadis',
    'oğuzhan Yeşiltuna',
    'Eminenur Kızıldağ',
    'Fundan Yaramış',
  ];
  const aliases = new Set(getContributorAliases().map((entry) => entry.alias));
  const reader = openReadOnly(path.join(__dirname, '../content/public.sqlite'));

  try {
    retiredNames.forEach((name) => {
      assert.strictEqual(aliases.has(name), false);
      assert.strictEqual(canonicalizeContributorName(name), name);
      assert.strictEqual(
        reader.get(
          'SELECT COUNT(*) AS matches FROM pages WHERE instr(content, ?) > 0',
          name,
        ).matches,
        0,
      );
    });
  } finally {
    reader.close();
  }
});

test('extracts crawlable work starts from issue contents', () => {
  const entries = extractTocEntries(`
    <table class="mContents">
      <tr><td><a href="/dergiler/sayi12/7">Bir Şiir<span class="mContentsAuthors">Ada Yazar</span></a></td></tr>
      <tr><td><a href="/dergiler/sayi12/9"><i>Ses Makinesi</i><span class="mContentsAuthors">&nbsp;</span></a></td></tr>
    </table>
  `);
  assert.deepStrictEqual(entries, [
    {
      magazineIndex: 12,
      startPage: 7,
      title: 'Bir Şiir',
      author: 'Ada Yazar',
    },
    {
      magazineIndex: 12,
      startPage: 9,
      title: 'Ses Makinesi',
      author: '',
    },
  ]);
});

test('extracts and deduplicates issue-cover contributors from the colophon', () => {
  const contributors = extractCoverContributors(`
    <table>
      <tr><td class="mKunyeTitle">Kapak</td></tr>
      <tr>
        <td><a href="#"><i class="icon"></i></a></td>
        <td><a href="#">Burak Özkan (Tumblr)</a></td>
      </tr>
      <tr>
        <td><a href="#"><i class="icon"></i></a></td>
        <td><a href="#">Burak Özkan (Instagram)</a></td>
      </tr>
      <tr><td class="mKunyeTitle">Teknik Ekip</td></tr>
      <tr><td><a href="#">Başka Birisi</a></td></tr>
    </table>
  `);
  assert.deepStrictEqual(contributors, ['Burak Özkan']);
});

test('extracts strict page-level visual credits and full-size images', () => {
  const plain = extractPageVisual(`
    <a href="/images/sayi2/1b.jpg" target="_blank">
      <img class="mIcResim" src="/images/sayi2/1.jpg" />
    </a>
    <br />
    <font style="font-size:11px"><em>Burak Özkan</em></font>
  `);
  const prefixed = extractPageVisual(`
    <img class="mIcResim" src="/images/sayi22/1.jpg" />
    <br />
    <fon style="font-size:10px"><em>Fotoğraf: Defne Hadiş</em></font>
  `);
  const handle = extractPageVisual(`
    <img class="mIcResim" src="/images/sayi45/semih.jpg" />
    <a href="https://instagram.com/semihbnw">semihbnw</a>
  `);

  assert.strictEqual(plain.imagePath, '/images/sayi2/1b.jpg');
  assert.deepStrictEqual(plain.contributors, ['Burak Özkan']);
  assert.deepStrictEqual(plain.visibleContributors, ['Burak Özkan']);
  assert.strictEqual(prefixed.creditLabel, 'Fotoğraf');
  assert.deepStrictEqual(prefixed.contributors, ['Defne Hadiş']);
  assert.deepStrictEqual(handle.contributors, ['Semih Bozkurt']);
  assert.strictEqual(
    extractPrimaryImagePath('<img src="/images/fallback.webp" />'),
    '/images/fallback.webp',
  );
});

test('rejects ambiguous, uncredited, and non-standalone visual pages', () => {
  [
    '<img src="/images/back.jpg" />',
    '<h1 class="mTitle">Bir Görsel</h1><img src="/images/work.jpg" />',
    '<p class="mSiir">Bir şiir</p><img src="/images/illustration.jpg" />',
    '<p class="mNesir">Bir yazı</p><img src="/images/illustration.jpg" />',
    '<img src="/images/source.jpg" /><em>Kaynak: https://example.com</em>',
    '<img src="/images/book.jpg" /><p>Yeni şiir kitabımız yayımlandı ve satışa çıktı.</p>',
  ].forEach((html) => assert.strictEqual(extractPageVisual(html), null));
});

test('extracts corroboratable titled visuals and recognizes uncredited back covers', () => {
  const visual = extractTitledPageVisual(`
    <a href="/images/sayi46/bilgelik-buyuk.jpg">
      <img src="/images/sayi46/bilgelik.jpg" />
    </a>
    <em>Bilgelik Ağacı — Mert Bayram</em>
  `);
  assert.deepStrictEqual(visual, {
    imagePath: '/images/sayi46/bilgelik-buyuk.jpg',
    captionText: 'Bilgelik Ağacı — Mert Bayram',
    title: 'Bilgelik Ağacı',
    creditText: 'Mert Bayram',
    visibleContributors: ['Mert Bayram'],
    contributors: ['Mert Bayram'],
  });
  assert.strictEqual(
    extractPageVisual('<img src="/x.jpg"><em>Bilgelik Ağacı — Mert Bayram</em>'),
    null,
  );
  assert.strictEqual(
    isBackCoverPage('<img src="/images/sayi46/arka-kapak.jpg" />'),
    true,
  );
  assert.strictEqual(
    isBackCoverPage('<img src="/images/sayi46/arka-kapak.jpg" /><em>Kredi</em>'),
    false,
  );
});

test('pairs audio formats and extracts individual reciter metadata', () => {
  const recitations = extractRecitations(`
    <input type="hidden" name="player_songs" size="1" id="Göğe Bakma Durağı" value="Nafizcan Önder" class="/magazines/sayi12/audio/1.mp3" />
    <input type="hidden" name="player_songs" size="2" id="Göğe Bakma Durağı" value="Nafizcan Önder" class="/magazines/sayi12/audio/1.ogg" />
    <table>
      <tr><td><b>Şair:</b></td><td>Turgut Uyar</td></tr>
      <tr><td><b>Şiir Adı:</b></td><td>Göğe Bakma Durağı</td></tr>
      <tr><td><b>Okuyan:</b></td><td>Nafizcan Önder</td></tr>
    </table>
  `);
  assert.strictEqual(recitations.length, 1);
  assert.strictEqual(recitations[0].mp3Path, '/magazines/sayi12/audio/1.mp3');
  assert.strictEqual(recitations[0].oggPath, '/magazines/sayi12/audio/1.ogg');
  assert.strictEqual(recitations[0].poetName, 'Turgut Uyar');
  assert.deepStrictEqual(recitations[0].reciters, ['Nafizcan Önder']);
  assert.deepStrictEqual(recitations[0].warnings, []);
});

test('extracts every original poet from a grouped legacy metadata table', () => {
  const recitations = extractRecitations(`
    <input name="player_songs" size="1" id="Birinci Şiir" value="Ada Okur" class="/audio/1.mp3" />
    <input name="player_songs" size="1" id="İkinci Şiir" value="Ece Okur" class="/audio/2.mp3" />
    <table>
      <tr><td>Sıra:</td><td>1</td></tr>
      <tr><td>Şair:</td><td>Birinci Şair</td></tr>
      <tr><td>Şiir Adı:</td><td>Birinci Şiir</td></tr>
      <tr><td>Okuyan:</td><td>Ada Okur</td></tr>
      <tr><td>Sıra:</td><td>2</td></tr>
      <tr><td>Şair:</td><td>İkinci Şair</td></tr>
      <tr><td>Şiir Adı:</td><td>İkinci Şiir</td></tr>
      <tr><td>Okuyan:</td><td>Ece Okur</td></tr>
    </table>
  `);

  assert.deepStrictEqual(
    recitations.map((recitation) => [
      recitation.poemTitle,
      recitation.poetName,
      recitation.reciters,
    ]),
    [
      ['Birinci Şiir', 'Birinci Şair', ['Ada Okur']],
      ['İkinci Şiir', 'İkinci Şair', ['Ece Okur']],
    ],
  );
});

test('extracts plain-text and positional legacy recitation credits', () => {
  const plain = extractRecitations(`
    <p class="mSiir">
      1 - Bedri Rahmi Eyüboğlu - Arkadaş Dökümü - Ozan Ceyhan Türülken<br />
      2 - Nafizcan Önder - (başlık yok) - Semih Bozkurt
    </p>
    <input name="player_songs" size="1" id="Arkadaş Dökümü"
      value="Ozan Ceyhan Türülken" class="/audio/1.mp3" />
    <input name="player_songs" size="1" id=""
      value="Semih Bozkurt" class="/audio/2.mp3" />
  `);
  const positional = extractRecitations(`
    <table>
      <tr><td>1.</td><td>Attila İlhan</td><td>Batan Bu Köhne Şileb</td><td>Samet Pehlivan</td></tr>
      <tr><td>2.</td><td>Can Yücel</td><td>Buluşmak Üzere</td><td>Ozan Ceyhan Türülken</td></tr>
    </table>
    <input name="player_songs" size="1" id="Batan Bu Köhne Şileb"
      value="Samet Pehlivan" class="/audio/1.mp3" />
    <input name="player_songs" size="1" id="Buluşmak Üzere"
      value="Ozan Ceyhan Türülken" class="/audio/2.mp3" />
  `);

  assert.deepStrictEqual(
    plain.map((recitation) => [
      recitation.poemTitle,
      recitation.poetName,
      recitation.reciters,
    ]),
    [
      ['Arkadaş Dökümü', 'Bedri Rahmi Eyüboğlu', ['Ozan Ceyhan Türülken']],
      ['(başlık yok)', 'Nafizcan Önder', ['Semih Bozkurt']],
    ],
  );
  assert.deepStrictEqual(
    positional.map((recitation) => [
      recitation.poemTitle,
      recitation.poetName,
      recitation.reciters,
    ]),
    [
      ['Batan Bu Köhne Şileb', 'Attila İlhan', ['Samet Pehlivan']],
      ['Buluşmak Üzere', 'Can Yücel', ['Ozan Ceyhan Türülken']],
    ],
  );
});

test('uses Yazar and Tarih for non-poetry literary readings', () => {
  const [recitation] = extractRecitations(`
    <input name="player_songs" size="1" id="1" value="Ada Okur" class="/audio/1.mp3" />
    <table>
      <tr><td>Sıra:</td><td>1</td></tr>
      <tr><td>Yazar:</td><td>Tezer Özlü</td></tr>
      <tr><td>Tarih:</td><td>Eylül 1966</td></tr>
      <tr><td>Okuyan:</td><td>Ada Okur</td></tr>
    </table>
  `);
  assert.strictEqual(recitation.kind, 'literary-reading');
  assert.strictEqual(recitation.poemTitle, 'Eylül 1966');
  assert.strictEqual(recitation.poetName, 'Tezer Özlü');
});

test('keeps repeated title and reciter pairs as distinct recordings', () => {
  const recitations = extractRecitations(`
    <input name="player_songs" size="1" id="Aynı Şiir" value="Ada Okur" class="/audio/1.mp3" />
    <input name="player_songs" size="1" id="Aynı Şiir" value="Ada Okur" class="/audio/2.mp3" />
    <input name="player_songs" size="2" id="Aynı Şiir" value="Ada Okur" class="/audio/1.ogg" />
    <input name="player_songs" size="2" id="Aynı Şiir" value="Ada Okur" class="/audio/2.ogg" />
  `);
  assert.strictEqual(recitations.length, 2);
  assert.strictEqual(recitations[0].mp3Path, '/audio/1.mp3');
  assert.strictEqual(recitations[0].oggPath, '/audio/1.ogg');
  assert.strictEqual(recitations[1].mp3Path, '/audio/2.mp3');
  assert.strictEqual(recitations[1].oggPath, '/audio/2.ogg');
});

test('ignores exact duplicate player inputs with an incorrect legacy size', () => {
  const recitations = extractRecitations(`
    <input name="player_songs" size="1" id="Bir Şiir" value="Ada Okur" class="/audio/1.mp3" />
    <input name="player_songs" size="2" id="Bir Şiir" value="Ada Okur" class="/audio/1.mp3" />
  `);
  assert.strictEqual(recitations.length, 1);
  assert.strictEqual(recitations[0].mp3Path, '/audio/1.mp3');
});

test('matches shifted legacy metadata tables by visible reciter credit', () => {
  const recitations = extractRecitations(`
    <input name="player_songs" size="1" id="Başka Başlık" value="Ada Okur" class="/audio/1.mp3" />
    <input name="player_songs" size="1" id="İkinci Başlık" value="Ece Okur" class="/audio/2.mp3" />
    <table>
      <tr><td>Şiir Adı:</td><td>İkinci Görünen Başlık</td></tr>
      <tr><td>Okuyan:</td><td>Ece Okur</td></tr>
    </table>
    <table>
      <tr><td>Şiir Adı:</td><td>Birinci Görünen Başlık</td></tr>
      <tr><td>Okuyan:</td><td>Ada Okur</td></tr>
    </table>
  `);
  assert.strictEqual(recitations[0].poemTitle, 'Birinci Görünen Başlık');
  assert.deepStrictEqual(recitations[0].reciters, ['Ada Okur']);
  assert.strictEqual(recitations[1].poemTitle, 'İkinci Görünen Başlık');
  assert.deepStrictEqual(recitations[1].reciters, ['Ece Okur']);
});

test('does not assign a lone later-track metadata table to the first player input', () => {
  const recitations = extractRecitations(`
    <input name="player_songs" size="1" id="Birinci Şiir" value="Ada Okur" class="/audio/1.mp3" />
    <input name="player_songs" size="1" id="İkinci Şiir" value="Ece Okur" class="/audio/2.mp3" />
    <table>
      <tr><td>Sıra:</td><td>2</td></tr>
      <tr><td>Şair:</td><td>Bir Şair</td></tr>
      <tr><td>Şiir Adı:</td><td>İkinci Şiir</td></tr>
      <tr><td>Okuyan:</td><td>Ece Okur</td></tr>
    </table>
  `);
  assert.strictEqual(recitations[0].poemTitle, 'Birinci Şiir');
  assert.deepStrictEqual(recitations[0].reciters, ['Ada Okur']);
  assert.strictEqual(recitations[0].metadataTableIndex, undefined);
  assert.strictEqual(recitations[1].poemTitle, 'İkinci Şiir');
  assert.deepStrictEqual(recitations[1].reciters, ['Ece Okur']);
  assert.strictEqual(recitations[1].metadataTableIndex, 0);
  assert.strictEqual(
    recitations.some((recitation) => (
      recitation.warnings.some((warning) => warning.startsWith('Player credit'))
    )),
    false,
  );
});

test('expands named ensembles and creates a profile credit for an unnamed team', () => {
  const named = extractRecitations(`
    <input type="hidden" name="player_songs" size="1" id="Dinleti" value="Galata Dergisi Ses Makinesi Ekibi" class="/audio/dinleti.mp3" />
    <input type="hidden" name="player_songs" size="2" id="Dinleti" value="Galata Dergisi Ses Makinesi Ekibi" class="/audio/dinleti.ogg" />
    <table>
      <tr><td><b>Şair:</b></td><td>Bir Şair</td></tr>
      <tr><td><b>Şiir Adı:</b></td><td>Dinleti</td></tr>
      <tr><td><b>Okuyanlar:</b></td><td>Ada Yazar, Ece Okur</td></tr>
    </table>
  `);
  assert.deepStrictEqual(named[0].reciters, ['Ada Yazar', 'Ece Okur']);
  assert.deepStrictEqual(named[0].warnings, []);

  const dashSeparated = extractRecitations(`
    <input name="player_songs" size="1" id="Dinleti" value="Galata Dergisi Ses Makinesi Ekibi" class="/audio/dinleti.mp3" />
    <input name="player_songs" size="2" id="Dinleti" value="Galata Dergisi Ses Makinesi Ekibi" class="/audio/dinleti.ogg" />
    <table>
      <tr><td>Şiir Adı:</td><td>Dinleti</td></tr>
      <tr><td>Okuyanlar:</td><td>Ada Yazar – Ece Okur</td></tr>
    </table>
  `);
  assert.deepStrictEqual(dashSeparated[0].reciters, ['Ada Yazar', 'Ece Okur']);

  const unresolved = extractRecitations(`
    <input type="hidden" name="player_songs" size="1" id="Dinleti" value="Galata Dergisi Ses Makinesi Ekibi" class="/audio/dinleti.mp3" />
  `);
  assert.deepStrictEqual(
    unresolved[0].reciters,
    ['Galata Dergisi Ses Makinesi Ekibi'],
  );
  assert.deepStrictEqual(
    unresolved[0].warnings,
    ['OGG source is not referenced in the page markup.'],
  );
});

test('adds crawlable profile links to visible work author fields', () => {
  const contributor = {
    id: 8,
    displayName: 'Ada Yazar',
    slug: 'ada-yazar',
  };
  const work = {
    startPage: 7,
    contributors: [contributor],
  };
  const heading = decorateWorkContributorHtml(
    '<h1 class="mAuthor">Ada Yazar</h1>',
    work,
    12,
    7,
  );
  const contents = decorateWorkContributorHtml(
    '<a href="/dergiler/sayi12/7">Bir Eser<span class="mContentsAuthors">Ada Yazar</span></a>',
    work,
    12,
    2,
  );
  assert.match(heading, /href="\/katkida-bulunanlar\/8-ada-yazar"/);
  assert.match(contents, /href="\/katkida-bulunanlar\/8-ada-yazar"/);
  assert.match(
    contents,
    /<\/a><span class="mContentsAuthors toc-contributor-links"><a class="contributor-link"/,
  );
  assert.doesNotMatch(
    contents,
    /<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/i,
  );
});

test('links aliases without changing visible contributor credit text', () => {
  const contributor = {
    id: 8,
    displayName: 'Büşra Elif Yüksel',
    slug: 'busra-elif-yuksel',
  };
  const work = {
    startPage: 7,
    contributors: [contributor],
  };
  const heading = decorateWorkContributorHtml(
    '<h1 class="mAuthor"><em>Belif Yüksel</em></h1>',
    work,
    12,
    7,
  );
  const contents = decorateWorkContributorHtml(
    '<a href="/dergiler/sayi12/7">Bir Eser<span class="mContentsAuthors">Belif Yüksel</span></a>',
    work,
    12,
    2,
  );
  const recitation = decorateRecitationHtml(`
    <table>
      <tr><td>Şiir Adı:</td><td>Bir Şiir</td></tr>
      <tr><td>Okuyan:</td><td>Belif Yüksel</td></tr>
    </table>
  `, [{
    id: 3,
    poemTitle: 'Bir Şiir',
    anchorId: 'ses-1',
    contributors: [contributor],
  }]);

  [heading, contents, recitation].forEach((html) => {
    assert.match(html, />Belif Yüksel<\/a>/);
    assert.doesNotMatch(html, />Büşra Elif Yüksel<\/a>/);
    assert.match(html, /href="\/katkida-bulunanlar\/8-busra-elif-yuksel"/);
  });
});

test('adds a descriptive cover credit to the issue image without visible markup', () => {
  const decorated = decorateWorkContributorHtml(
    '<img src="/cover.jpg" />',
    {
      startPage: 1,
      kind: 'issue-cover',
      contributors: [{
        id: 8,
        displayName: 'Defne Hadiş',
        slug: 'defne-hadis',
      }],
    },
    12,
    1,
  );
  assert.match(
    decorated,
    /alt="Galata Dergisi Sayı 12 kapağı — Defne Hadiş"/,
  );
});

test('links page-level visual credits without changing their visible caption', () => {
  const work = {
    startPage: 22,
    kind: 'page-visual',
    contributors: [{
      id: 8,
      displayName: 'Defne Hadiş',
      slug: 'defne-hadis',
    }],
  };
  const prefixed = decoratePageVisualContributorHtml(`
    <img class="mIcResim" src="/images/sayi22/1.jpg" />
    <br /><fon style="font-size:10px"><em>Fotoğraf: Defne Hadiş</em></fon>
  `, work);
  const linkedHandle = decoratePageVisualContributorHtml(`
    <img src="/images/sayi45/semih.jpg" />
    <a title="Instagram Profili" href="https://instagram.com/semihbnw"
      target="_blank">semihbnw</a>
  `, {
    ...work,
    contributors: [{
      id: 9,
      displayName: 'Semih Bozkurt',
      slug: 'semih-bozkurt',
    }],
  });

  assert.match(prefixed, /Fotoğraf: <a class="contributor-link"/);
  assert.match(prefixed, />Defne Hadiş<\/a>/);
  assert.match(prefixed, /<fon style="font-size:10px"><em>/);
  assert.match(
    linkedHandle,
    /<a\b[^>]*href="\/katkida-bulunanlar\/9-semih-bozkurt"[^>]*class="contributor-link"[^>]*>semihbnw<\/a>/,
  );
  assert.doesNotMatch(linkedHandle, /instagram\.com|target="_blank"|Instagram Profili/);
  assert.strictEqual((linkedHandle.match(/<a\b/g) || []).length, 1);
});

test('decorates inline images and videos without retargeting their media links', () => {
  const ismail = {
    id: 18,
    displayName: 'İsmail Sertaç Yılmaz',
    slug: 'ismail-sertac-yilmaz',
  };
  const drawing = decorateInlineMediaHtml(`
    <a class="legacy-image" href="/images/sayi17/1.jpg">
      <img src="/images/sayi17/1_t.jpg" alt="semih" />
    </a>
    <em>Çizim: İsmail Sertaç Yılmaz</em>
  `, [{
    title: 'Sayı 17, Sayfa 8 Çizimi',
    kind: 'drawing',
    mediaPath: '/images/sayi17/1.jpg',
    anchorId: 'gorsel-17-drawing',
    contributors: [ismail],
  }]);
  assert.match(
    drawing,
    /<a class="legacy-image" href="\/images\/sayi17\/1\.jpg" id="gorsel-17-drawing">/,
  );
  assert.match(
    drawing,
    /alt="Sayı 17, Sayfa 8 Çizimi — İsmail Sertaç Yılmaz"/,
  );
  assert.match(
    drawing,
    /Çizim: <a class="contributor-link" href="\/katkida-bulunanlar\/18-ismail-sertac-yilmaz">İsmail Sertaç Yılmaz<\/a>/,
  );
  assert.strictEqual((drawing.match(/<a\b/g) || []).length, 2);
  assert.doesNotMatch(
    drawing,
    /href="\/katkida-bulunanlar\/18-ismail-sertac-yilmaz"[^>]*>\s*<img/,
  );

  const video = decorateInlineMediaHtml(`
    <video controls><source src="/images/sayi44/semih-gorsel.mp4" /></video>
    <em>Video: Semih Bozkurt</em>
  `, [{
    title: 'Sayı 44, Sayfa 19 Videosu',
    kind: 'video',
    mediaPath: '/images/sayi44/semih-gorsel.mp4',
    anchorId: 'gorsel-44-video',
    contributors: [{
      id: 9,
      displayName: 'Semih Bozkurt',
      slug: 'semih-bozkurt',
    }],
  }]);
  assert.match(
    video,
    /<video controls id="gorsel-44-video" aria-label="Sayı 44, Sayfa 19 Videosu — Semih Bozkurt">/,
  );
  assert.match(video, /src="\/images\/sayi44\/semih-gorsel\.mp4"/);
  assert.match(
    video,
    /Video: <a class="contributor-link" href="\/katkida-bulunanlar\/9-semih-bozkurt">Semih Bozkurt<\/a>/,
  );
});

test('decorates public reciter links and stable track identifiers', () => {
  const html = `
    <input type="hidden" name="player_songs" size="1" id="Bir Şiir" value="Ada Yazar" class="/audio/1.mp3" />
    <table>
      <tr><td><b>Şair:</b></td><td>Bir Şair</td></tr>
      <tr><td><b>Şiir Adı:</b></td><td>Bir Şiir</td></tr>
      <tr><td><b>Okuyan:</b></td><td>Ada Yazar</td></tr>
    </table>
  `;
  const decorated = decorateRecitationHtml(html, [{
    id: 3,
    poemTitle: 'Bir Şiir',
    poetName: 'Bir Şair',
    mp3Path: '/audio/1.mp3',
    oggPath: null,
    anchorId: 'ses-1-5-1',
    contributors: [{
      id: 8,
      displayName: 'Ada Yazar',
      slug: 'ada-yazar',
    }],
  }]);
  assert.match(decorated, /data-recitation-id="ses-1-5-1"/);
  assert.match(decorated, /id="ses-1-5-1"/);
  assert.match(decorated, /href="\/katkida-bulunanlar\/8-ada-yazar"/);
});

test('links only reciters in plain-text and positional legacy credits', () => {
  const contributors = [{
    id: 8,
    displayName: 'Nafizcan Önder',
    slug: 'nafizcan-onder',
  }, {
    id: 9,
    displayName: 'Semih Bozkurt',
    slug: 'semih-bozkurt',
  }];
  const recitations = [{
    id: 1,
    poemTitle: '',
    poetName: 'Nafizcan Önder',
    anchorId: 'ses-1',
    contributors: [contributors[1]],
  }, {
    id: 2,
    poemTitle: 'Başka Şiir',
    poetName: 'Bir Şair',
    anchorId: 'ses-2',
    contributors: [contributors[0]],
  }];
  const plain = decorateRecitationHtml(`
    <p class="mSiir">
      1 - Nafizcan Önder - (başlık yok) - Semih Bozkurt<br />
      2 - Bir Şair - Başka Şiir - Nafizcan Önder
    </p>
  `, recitations);
  const positional = decorateRecitationHtml(`
    <table>
      <tr><td>1.</td><td>Bir Şair</td><td>Başka Şiir</td><td>Nafizcan Önder</td></tr>
    </table>
  `, recitations);

  assert.strictEqual(
    (plain.match(/href="\/katkida-bulunanlar\/8-nafizcan-onder"/g) || []).length,
    1,
  );
  assert.match(plain, /Nafizcan Önder - \(başlık yok\) -/);
  assert.match(plain, /href="\/katkida-bulunanlar\/9-semih-bozkurt"/);
  assert.match(
    positional,
    /<td><a class="contributor-link" href="\/katkida-bulunanlar\/8-nafizcan-onder">Nafizcan Önder<\/a><\/td>/,
  );
  assert.doesNotMatch(
    positional,
    /<td><a[^>]+>Bir Şair<\/a><\/td>/,
  );
});

test('decorates story character performers with public profile links', () => {
  const html = `
    <table>
      <tr><td>Sıra:</td><td>1</td></tr>
      <tr><td>Yazar:</td><td>Bir Yazar</td></tr>
      <tr><td>Öykü Adı:</td><td>Bir Öykü</td></tr>
      <tr><td>Karakterler:</td><td></td></tr>
      <tr><td>Anlatıcı:</td><td>Semih Bozkurt</td></tr>
    </table>
  `;
  const decorated = decorateRecitationHtml(html, [{
    id: 3,
    poemTitle: 'Bir Öykü',
    poetName: 'Bir Yazar',
    mp3Path: '/audio/1.mp3',
    oggPath: null,
    anchorId: 'ses-1-5-1',
    contributors: [{
      id: 8,
      displayName: 'Semih Bozkurt',
      slug: 'semih-bozkurt',
    }],
  }]);
  assert.match(
    decorated,
    /Anlatıcı:[\s\S]*href="\/katkida-bulunanlar\/8-semih-bozkurt"/,
  );
});

test('generates a canonical-only sitemap without recitation fragments', () => {
  const sitemap = renderSitemap('https://galatadergisi.org', {
    magazines: [{ id: 12, publishDate: new Date('2026-01-01T00:00:00Z') }],
    works: [
      {
        magazineIndex: 12,
        startPage: 1,
        kind: 'issue-cover',
        publishDate: '2026-01-01T00:00:00Z',
      },
      {
        magazineIndex: 12,
        startPage: 7,
        kind: 'work',
        publishDate: '2026-01-01T00:00:00Z',
      },
      {
        magazineIndex: 12,
        startPage: 22,
        kind: 'page-visual',
        publishDate: '2026-01-01T00:00:00Z',
      },
    ],
    contributors: [{
      id: 8,
      slug: 'ada-yazar',
      lastModified: '2026-01-01T00:00:00Z',
    }],
  });
  assert.match(sitemap, /https:\/\/galatadergisi\.org\/dergiler\/sayi12\/7/);
  assert.match(sitemap, /https:\/\/galatadergisi\.org\/dergiler\/sayi12\/22/);
  assert.match(sitemap, /https:\/\/galatadergisi\.org\/katkida-bulunanlar\/8-ada-yazar/);
  assert.strictEqual(
    (sitemap.match(/https:\/\/galatadergisi\.org\/telif-ve-kullanim/g) || []).length,
    1,
  );
  assert.doesNotMatch(sitemap, /https:\/\/galatadergisi\.org\/dergiler\/sayi12\/1/);
  assert.strictEqual(
    (sitemap.match(/https:\/\/galatadergisi\.org\/dergiler\/sayi12/g) || []).length,
    3,
  );
  assert.doesNotMatch(sitemap, /#ses-/);
  assert.doesNotMatch(sitemap, /#gorsel-/);
  assert.strictEqual(
    (sitemap.match(/<lastmod>2026-01-01T00:00:00.000Z<\/lastmod>/g) || []).length,
    5,
  );
});

test('publishes a crawlable rights page and organization-owned image metadata', () => {
  const renderer = new SeoRenderer({
    templatePath: path.join(__dirname, '../client/pages/homepage/index.html'),
    ssrBundlePath: path.join(__dirname, '../build/ssr/does-not-exist.cjs'),
    baseUrl: 'https://galatadergisi.org',
  });
  const rightsUrl = 'https://galatadergisi.org/telif-ve-kullanim';
  const rightsHtml = renderer.renderRightsPage();
  const rightsMarkdown = fs.readFileSync(
    path.join(__dirname, '../content/pages/telif-ve-kullanim.md'),
    'utf8',
  );
  const rightsData = structuredDataFromHtml(rightsHtml);
  const logo = graphNode(
    rightsData,
    (node) => node['@type'] === 'ImageObject'
      && node['@id'] === 'https://galatadergisi.org/#logo',
  );

  assert.match(
    rightsHtml,
    /<link rel="canonical" href="https:\/\/galatadergisi\.org\/telif-ve-kullanim" \/>/,
  );
  assert.match(rightsHtml, /href="\/assets\/static-page\.css"/);
  assert.match(rightsHtml, /href="mailto:bilgi@galatadergisi\.org"/);
  assert.match(rightsHtml, /<h2 id="dergi-icerigi-ve-gorseller">/);
  assert.match(rightsHtml, /<h2 id="izin-talebi">/);
  assert.match(rightsHtml, /tüm hakları saklı eserlerdir/);
  assert.match(rightsHtml, /GNU\s+Genel Kamu Lisansı sürüm 3\.0 veya sonrası/);
  assert.match(rightsMarkdown, /^---\n/);
  assert.match(rightsMarkdown, /^## Dergi içeriği ve görseller$/m);
  assert.doesNotMatch(rightsMarkdown, /<h2/);
  assert.deepStrictEqual(logo.creator.map((creator) => creator.name), ['Galata Dergisi']);
  assert.strictEqual(logo.creditText, 'Galata Dergisi');
  assert.strictEqual(logo.copyrightNotice, '© Galata Dergisi');
  assert.strictEqual(logo.license, rightsUrl);
  assert.strictEqual(logo.acquireLicensePage, rightsUrl);

  const issueMetadata = renderer.createIssueMetadata({
    index: 8,
    publishDateText: 'Ocak 2015',
    publishDate: new Date('2015-01-01T00:00:00Z'),
    thumbnailURL: '/images/sayi8/thumbnail.jpg',
  }, null, [{
    magazineIndex: 8,
    startPage: 2,
    endPage: 5,
    title: 'Sayı 8 İçeriği',
    type: 'prose',
    kind: 'work',
    contributors: [],
    recitations: [],
    media: [],
  }]);
  const coverImage = graphNode(
    issueMetadata.structuredData,
    (node) => node['@type'] === 'ImageObject'
      && node.contentUrl === 'https://galatadergisi.org/images/sayi8/thumbnail.jpg',
  );
  assert.deepStrictEqual(
    coverImage.creator.map((creator) => creator.name),
    ['Galata Dergisi'],
  );
  assert.strictEqual(coverImage.copyrightNotice, '© Galata Dergisi');
  assert.strictEqual(coverImage.license, rightsUrl);
  assert.strictEqual(coverImage.acquireLicensePage, rightsUrl);
});

test('renders static Markdown pages safely and deterministically', () => {
  const source = `---
title: Deneme
description: Açıklama
lead: Giriş
---

## İzin talebi

Bir [bağlantı](https://example.com) ve <script>alert(1)</script>.

[Güvensiz](javascript:alert(1))`;
  const first = renderMarkdownPageSource(source, 'test page');
  const second = renderMarkdownPageSource(source, 'test page');

  assert.deepStrictEqual(first, second);
  assert.strictEqual(first.title, 'Deneme');
  assert.match(first.html, /<h2 id="izin-talebi">İzin talebi<\/h2>/);
  assert.match(first.html, /href="https:\/\/example\.com"/);
  assert.match(first.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(first.html, /href="javascript:/);
  assert.throws(
    () => renderMarkdownPageSource('## Başlık', 'broken page'),
    /must start with front matter/,
  );
});

test('renders a deterministic Atom feed for canonical works', () => {
  const feed = renderAtomFeed('https://galatadergisi.org', [{
    title: 'Eski & <Eser>',
    canonical: 'https://galatadergisi.org/dergiler/sayi1/7',
    published: '2025-01-01T00:00:00.000Z',
    magazineIndex: 1,
    startPage: 7,
    authors: ['Ada & Yazar', 'İkinci Yazar'],
    summary: 'Alıntı <metin> & devamı.',
    type: 'poetry',
  }, {
    title: 'Yeni Eser',
    canonical: 'https://galatadergisi.org/dergiler/sayi2/11',
    published: '2026-01-01T00:00:00.000Z',
    magazineIndex: 2,
    startPage: 11,
    authors: [],
    summary: 'Yeni eserin özeti.',
    type: 'visual',
  }]);

  assert.match(feed, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(feed, /xmlns="http:\/\/www\.w3\.org\/2005\/Atom" xml:lang="tr"/);
  assert.match(feed, /rel="self" type="application\/atom\+xml"/);
  assert(feed.indexOf('Yeni Eser') < feed.indexOf('Eski &amp; &lt;Eser&gt;'));
  assert.match(feed, /<name>Ada &amp; Yazar<\/name>/);
  assert.match(feed, /<name>İkinci Yazar<\/name>/);
  assert.match(feed, /<summary type="text">Alıntı &lt;metin&gt; &amp; devamı\.<\/summary>/);
  assert.strictEqual((feed.match(/<entry>/g) || []).length, 2);
  assert.throws(
    () => renderAtomFeed('https://galatadergisi.org', [{
      title: 'Hatalı',
      canonical: 'https://galatadergisi.org/dergiler/sayi1/1',
      published: 'not-a-date',
      magazineIndex: 1,
      startPage: 1,
      summary: 'Hatalı tarih.',
      type: 'prose',
    }]),
    /Invalid Atom publication date/,
  );
});

test('renders canonical metadata and privacy-safe contributor sections', () => {
  const renderer = new SeoRenderer({
    templatePath: path.join(__dirname, '../client/pages/homepage/index.html'),
    ssrBundlePath: path.join(__dirname, '../build/ssr/does-not-exist.cjs'),
    baseUrl: 'https://galatadergisi.org',
    publicRoot: path.join(__dirname, '../public'),
  });
  const profile = {
    id: 4,
    displayName: 'Ada Yazar',
    slug: 'ada-yazar',
    works: [{
      id: 1,
      magazineIndex: 2,
      startPage: 7,
      title: 'Bir Eser',
      type: 'creative-work',
      kind: 'work',
      publishDateText: 'Ocak 2026',
    }, {
      id: 6,
      magazineIndex: 4,
      startPage: 9,
      title: 'Düzyazı Başlıklı Eser',
      type: 'prose',
      kind: 'work',
      publishDateText: 'Mart 2026',
    }, {
      id: 5,
      magazineIndex: 3,
      startPage: 8,
      title: 'Şiir Başlıklı Eser',
      type: 'poetry',
      kind: 'work',
      publishDateText: 'Şubat 2026',
    }, {
      id: 4,
      magazineIndex: 2,
      startPage: 22,
      title: 'Sayı 2, Sayfa 22 Görseli',
      type: 'visual',
      kind: 'page-visual',
      publishDateText: 'Ocak 2026',
    }, {
      id: 3,
      magazineIndex: 12,
      startPage: 1,
      title: 'Sayı 12 Kapağı',
      type: 'visual',
      kind: 'issue-cover',
      publishDateText: 'Ocak 2026',
    }],
    mediaContributions: [{
      id: 9,
      magazineIndex: 46,
      startPage: 7,
      pageNumber: 8,
      title: 'Sayı 46, Sayfa 8 Fotoğrafı',
      kind: 'photograph',
      mediaPath: '/images/sayi46/1.jpg',
      anchorId: 'gorsel-46-photograph',
      publishDateText: 'Ocak 2026',
      publishDate: new Date('2026-01-01T00:00:00Z'),
      contributors: [{
        id: 4,
        displayName: 'Ada Yazar',
        slug: 'ada-yazar',
      }, {
        id: 11,
        displayName: 'Deniz Çizer',
        slug: 'deniz-cizer',
      }],
    }],
    recitations: [{
      id: 2,
      magazineIndex: 2,
      startPage: 20,
      pageNumber: 21,
      poemTitle: 'Bir Şiir',
      poetName: 'Bir Şair',
      anchorId: 'ses-2-20-1',
      publishDateText: 'Ocak 2026',
    }, {
      id: 5,
      magazineIndex: 6,
      startPage: 36,
      pageNumber: 36,
      poemTitle: '',
      poetName: 'Nafizcan Önder',
      anchorId: 'ses-6-36-2',
      publishDateText: 'Ocak 2015',
    }, {
      id: 6,
      magazineIndex: 34,
      startPage: 27,
      pageNumber: 27,
      kind: 'story-narration',
      poemTitle: 'Sahte Pelerin',
      poetName: 'Nafizcan Önder',
      role: 'Masal Anlatıcısı',
      anchorId: 'ses-34-27-1',
      publishDateText: 'Ocak 2018',
    }, {
      id: 7,
      magazineIndex: 34,
      startPage: 27,
      pageNumber: 27,
      kind: 'story-narration',
      poemTitle: 'Bir Fasit Daire',
      poetName: 'Oğuzhan Yeşiltuna',
      role: 'Hekim',
      anchorId: 'ses-34-27-2',
      publishDateText: 'Ocak 2018',
    }],
  };
  const originalRecitationOrder = profile.recitations.map(({ id }) => id);
  const html = renderer.renderProfile(profile);
  assert.deepStrictEqual(
    profile.recitations.map(({ id }) => id),
    originalRecitationOrder,
  );
  const profileStructuredData = structuredDataFromHtml(html);
  assert.match(html, /<main id="sayfa-basi" class="profile-compact">/);
  assert.match(html, /<a href="\/">← Galata Dergisi<\/a>/);
  assert.match(
    html,
    /<p class="profile-summary">3 yazılı katkı · 2 görsel katkı · 1 kapak görseli · 4 sesli katkı<\/p>/,
  );
  assert.match(html, /<p class="issue-range">Sayı 2 – Sayı 46<\/p>/);
  assert.doesNotMatch(html, /class="section-nav"|class="profile-search"/);
  assert.match(html, /<section id="katkilari">/);
  assert.match(html, /<h2>Katkıları<\/h2>/);
  assert.match(html, /<h3>Yazılı Katkılar <span>\(3\)<\/span><\/h3>/);
  assert.match(html, /<h3>Görsel Katkılar <span>\(2\)<\/span><\/h3>/);
  assert.match(html, /<h3>Kapak Görselleri <span>\(1\)<\/span><\/h3>/);
  assert.match(html, /<h3>Ses Makinesi <span>\(4\)<\/span><\/h3>/);
  assert(
    html.indexOf('Yazılı Katkılar') < html.indexOf('Görsel Katkılar')
      && html.indexOf('Görsel Katkılar') < html.indexOf('Kapak Görselleri')
      && html.indexOf('Kapak Görselleri') < html.indexOf('Ses Makinesi'),
  );
  assert.doesNotMatch(
    html,
    /(?:id|href)="(?:#)?(?:eserleri|yazili-eserler|gorsel-eserler|seslendirmeleri)"/,
  );
  assert.match(
    html,
    /Bir Eser<\/a>[\s\S]*?<span class="contribution-type">Düzyazı<\/span>[\s\S]*?href="\/dergiler\/sayi2">Sayı 2<\/a>[\s\S]*?Ocak 2026/,
  );
  assert.match(
    html,
    /Düzyazı Başlıklı Eser<\/a>[\s\S]*?<span class="contribution-type">Düzyazı<\/span>[\s\S]*?href="\/dergiler\/sayi4">Sayı 4<\/a>[\s\S]*?Mart 2026/,
  );
  assert.match(
    html,
    /Şiir Başlıklı Eser<\/a>[\s\S]*?<span class="contribution-type">Şiir<\/span>[\s\S]*?href="\/dergiler\/sayi3">Sayı 3<\/a>[\s\S]*?Şubat 2026/,
  );
  assert.match(
    html,
    /Sayı 2, Sayfa 22 Görseli<\/a>[\s\S]*?<span class="contribution-type">Görsel<\/span>[\s\S]*?href="\/dergiler\/sayi2">Sayı 2<\/a>[\s\S]*?Ocak 2026/,
  );
  assert.match(
    html,
    /Sayı 12 Kapağı<\/a>[\s\S]*?<span class="contribution-type">Kapak Görseli<\/span>[\s\S]*?href="\/dergiler\/sayi12">Sayı 12<\/a>[\s\S]*?Ocak 2026/,
  );
  assert.match(html, /Bir Şiir — Bir Şair/);
  assert.match(html, /\(başlık yok\) — Nafizcan Önder/);
  const recitationsSectionHtml = html.slice(html.indexOf('id="ses-makinesi"'));
  assert(
    recitationsSectionHtml.indexOf('Sahte Pelerin')
      < recitationsSectionHtml.indexOf('(başlık yok)'),
  );
  assert(
    recitationsSectionHtml.indexOf('(başlık yok)')
      < recitationsSectionHtml.indexOf('Bir Şiir — Bir Şair'),
  );
  assert.match(
    html,
    /Sahte Pelerin[\s\S]*?<\/a>\s*<span class="contribution-note">adlı hikayede anlatıcıyı seslendirdi\.<\/span>/,
  );
  assert.match(
    html,
    /Bir Fasit Daire[\s\S]*?<\/a>\s*<span class="contribution-note">adlı hikayede Hekim karakterini seslendirdi\.<\/span>/,
  );
  assert.match(html, /<span class="contribution-type">Ses<\/span>/);
  assert.doesNotMatch(html, /<span class="contribution-type">Seslendirme<\/span>/);
  assert.doesNotMatch(html, /Rol:/);
  assert.match(html, /\/dergiler\/sayi2\/21#ses-2-20-1/);
  assert.doesNotMatch(html, /katkida-bulunanlar[^"]*bir-sair/i);
  const recitationNode = graphNode(
    profileStructuredData,
    (node) => node['@id']
      === 'https://galatadergisi.org/dergiler/sayi2/21#ses-2-20-1',
  );
  assert.strictEqual(recitationNode.creator[0].name, 'Bir Şair');
  assert.match(html, /href="\/dergiler\/sayi12">Sayı 12 Kapağı<\/a>/);
  assert.match(
    html,
    /href="\/dergiler\/sayi2\/22">Sayı 2, Sayfa 22 Görseli<\/a>/,
  );
  assert.match(
    html,
    /href="\/dergiler\/sayi46\/8#gorsel-46-photograph">Sayı 46, Sayfa 8 Fotoğrafı<\/a>/,
  );
  assert.match(
    html,
    /<span class="contribution-type">Fotoğraf<\/span>[\s\S]*?href="\/dergiler\/sayi46">Sayı 46<\/a>[\s\S]*?Ocak 2026/,
  );
  assert.doesNotMatch(html, /Yayınlanmış (?:eser|seslendirme) bulunmuyor\./);

  const worksOnlyHtml = renderer.renderProfile({
    ...profile,
    id: 5,
    displayName: 'Yalnız Yazar',
    slug: 'yalniz-yazar',
    works: [profile.works[0]],
    mediaContributions: [],
    recitations: [],
  });
  assert.match(worksOnlyHtml, /<h2>Katkıları<\/h2>/);
  assert.match(worksOnlyHtml, /1 yazılı katkı/);
  assert.match(worksOnlyHtml, /<p class="issue-range">Sayı 2<\/p>/);
  assert.match(worksOnlyHtml, /<li class="contribution-row" id="yazili-katkilar">/);
  assert.doesNotMatch(
    worksOnlyHtml,
    /class="section-nav"|class="profile-search"|class="profile-footer"|<h3>|Başa dön/,
  );
  assert.doesNotMatch(worksOnlyHtml, /Yayınlanmış (?:eser|seslendirme) bulunmuyor\./);

  const fallbackLabelHtml = renderer.renderProfile({
    ...profile,
    id: 10,
    displayName: 'Türü Bilinmeyen Katkıcı',
    slug: 'turu-bilinmeyen-katkici',
    works: [{
      ...profile.works[0],
      id: 10,
      type: 'unknown',
    }],
    mediaContributions: [],
    recitations: [],
  });
  assert.match(fallbackLabelHtml, /<span class="contribution-type">Katkı<\/span>/);
  assert.doesNotMatch(fallbackLabelHtml, /<span class="contribution-type">Eser<\/span>/);

  const recitationsOnlyHtml = renderer.renderProfile({
    ...profile,
    id: 6,
    displayName: 'Yalnız Seslendiren',
    slug: 'yalniz-seslendiren',
    works: [],
    mediaContributions: [],
    recitations: [profile.recitations[0]],
  });
  assert.match(recitationsOnlyHtml, /<h2>Katkıları<\/h2>/);
  assert.match(recitationsOnlyHtml, /1 sesli katkı/);
  assert.match(
    recitationsOnlyHtml,
    /<li class="contribution-row" id="ses-makinesi">/,
  );
  assert.doesNotMatch(
    recitationsOnlyHtml,
    /class="section-nav"|class="profile-search"|class="profile-footer"|<h3>|Başa dön/,
  );
  assert.doesNotMatch(
    recitationsOnlyHtml,
    /Yayınlanmış (?:eser|seslendirme) bulunmuyor\./,
  );

  const mediaOnlyHtml = renderer.renderProfile({
    ...profile,
    id: 7,
    displayName: 'Yalnız Görsel Sanatçı',
    slug: 'yalniz-gorsel-sanatci',
    works: [],
    mediaContributions: [profile.mediaContributions[0]],
    recitations: [],
  });
  assert.match(mediaOnlyHtml, /<h2>Katkıları<\/h2>/);
  assert.match(mediaOnlyHtml, /1 görsel katkı/);
  assert.match(
    mediaOnlyHtml,
    /Fotoğraf[\s\S]*href="\/dergiler\/sayi46">Sayı 46<\/a>[\s\S]*Ocak 2026/,
  );
  assert.doesNotMatch(
    mediaOnlyHtml,
    /class="section-nav"|class="profile-search"|class="profile-footer"|<h3>|Başa dön/,
  );
  assert.match(
    html,
    /"@type":"VisualArtwork","@id":"https:\/\/galatadergisi\.org\/dergiler\/sayi46\/8#gorsel-46-photograph"/,
  );
  const contributionImage = graphNode(
    profileStructuredData,
    (node) => node['@type'] === 'ImageObject'
      && node.contentUrl === 'https://galatadergisi.org/images/sayi46/1.jpg',
  );
  assert(contributionImage);
  assert.deepStrictEqual(
    contributionImage.creator.map((creator) => creator.name),
    ['Ada Yazar', 'Deniz Çizer'],
  );
  assert.strictEqual(contributionImage.creditText, 'Ada Yazar, Deniz Çizer');
  assert.strictEqual(contributionImage.copyrightNotice, '© Ada Yazar, Deniz Çizer');
  assert.strictEqual(
    graphNode(
      profileStructuredData,
      (node) => node['@type'] === 'ProfilePage',
    ).dateModified,
    undefined,
  );
  assert.doesNotMatch(html, /dateModified|article:modified_time/);
  assert.strictEqual(
    (html.match(/href="\/dergiler\/sayi2\/22"/g) || []).length,
    1,
  );
  assert.strictEqual(
    (html.match(/href="\/dergiler\/sayi46\/8#gorsel-46-photograph"/g) || []).length,
    1,
  );
  assert.doesNotMatch(html, /\/dergiler\/sayi12\/1/);
  assert.doesNotMatch(html, /email|contributorEmail|driveId|message/);
  assert.match(html, /property="og:locale" content="tr_TR"/);
  assert.match(
    html,
    /property="og:image" content="https:\/\/galatadergisi\.org\/images\/header-logo\.jpg"/,
  );
  assert.match(
    html,
    /property="og:image:alt" content="Ada Yazar — Galata Dergisi katkıda bulunan profili"/,
  );
  assert.match(html, /property="og:image:type" content="image\/jpeg"/);
  assert.match(html, /property="og:image:width" content="\d+"/);
  assert.match(html, /property="og:image:height" content="\d+"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(html, /name="twitter:site" content="@GalataDergisi"/);
  assert.match(
    html,
    /name="twitter:image" content="https:\/\/galatadergisi\.org\/images\/header-logo\.jpg"/,
  );
  assert.match(
    html,
    /name="description" content="Ada Yazar: Galata Dergisi Sayı 2–46\. 3 yazılı katkı · 2 görsel katkı · 1 kapak görseli · 4 sesli katkı\."/,
  );
  assert(contrastRatio('#5f763d', '#ffffff') >= 4.5);
  assert(contrastRatio('#6b6b6b', '#ffffff') >= 4.5);
  assert(contrastRatio('#3f5226', '#eef2e8') >= 4.5);
  const profileStyles = fs.readFileSync(
    path.join(__dirname, '../client/pages/contributor/profile.css'),
    'utf8',
  );
  const profileScript = fs.readFileSync(
    path.join(__dirname, '../client/pages/contributor/profile.js'),
    'utf8',
  );
  assert.match(html, /href="\/assets\/contributor-profile\.css"/);
  assert.doesNotMatch(html, /<style\b/);
  assert.match(profileStyles, /--link-color: #5f763d;/);
  assert.match(profileStyles, /--meta-color: #6b6b6b;/);
  assert.match(profileStyles, /background: #d9d9d9/);
  assert.doesNotMatch(profileStyles, /linear-gradient/);
  assert.match(profileStyles, /\.profile-long \{[\s\S]*min-height: calc\(100vh - 80px\)/);
  assert.match(profileStyles, /min-height: 44px/);
  assert.match(
    profileStyles,
    /@media \(max-width: 600px\)[\s\S]*font-size: 14px;[\s\S]*line-height: 1\.5;[\s\S]*\.contribution-meta \{[\s\S]*min-height: 44px;[\s\S]*padding-bottom: 0;[\s\S]*\.contribution-issue \{[\s\S]*min-height: 44px;/,
  );
  assert.doesNotMatch(profileStyles, /min-height: 760px|Lucida Console|#698145|#777/);

  const longProfile = {
    ...profile,
    id: 8,
    displayName: 'Uzun Profil',
    slug: 'uzun-profil',
    works: Array.from({ length: 20 }, (_, index) => ({
      ...profile.works[0],
      id: 100 + index,
      magazineIndex: index + 1,
      startPage: 7 + index,
    })),
    mediaContributions: [],
    recitations: [],
  };
  const longHtml = renderer.renderProfile(longProfile);
  const fiveRowsHtml = renderer.renderProfile({
    ...longProfile,
    works: longProfile.works.slice(0, 5),
  });
  const sixRowsHtml = renderer.renderProfile({
    ...longProfile,
    works: longProfile.works.slice(0, 6),
  });
  const nineteenRowsHtml = renderer.renderProfile({
    ...longProfile,
    works: longProfile.works.slice(0, 19),
  });
  const longMixedHtml = renderer.renderProfile({
    ...longProfile,
    works: longProfile.works.slice(0, 18),
    mediaContributions: [profile.mediaContributions[0]],
    recitations: [profile.recitations[0]],
  });
  const flatMixedHtml = renderer.renderProfile({
    ...profile,
    id: 9,
    displayName: 'Karma Katkıcı',
    slug: 'karma-katkici',
    works: [profile.works[0]],
    mediaContributions: [profile.mediaContributions[0]],
    recitations: [profile.recitations[2]],
  });
  assert.match(fiveRowsHtml, /<main id="sayfa-basi" class="profile-compact">/);
  assert.match(fiveRowsHtml, /<h2>Katkıları<\/h2>/);
  assert.doesNotMatch(
    fiveRowsHtml,
    /<h3>|class="section-nav"|class="profile-search"|class="profile-footer"/,
  );
  assert.match(sixRowsHtml, /<h3>Yazılı Katkılar <span>\(6\)<\/span><\/h3>/);
  assert.doesNotMatch(
    sixRowsHtml,
    /class="section-nav"|class="profile-search"|class="profile-footer"/,
  );
  assert.match(
    nineteenRowsHtml,
    /<h3>Yazılı Katkılar <span>\(19\)<\/span><\/h3>/,
  );
  assert.doesNotMatch(
    nineteenRowsHtml,
    /class="section-nav"|class="profile-search"|class="profile-footer"|Başa dön/,
  );
  assert.match(longHtml, /<main id="sayfa-basi" class="profile-long">/);
  assert.match(longHtml, /<form class="profile-search" role="search" hidden>/);
  assert.match(longHtml, />Katkılarda ara<\/label>/);
  assert.doesNotMatch(longHtml, /class="section-nav"/);
  assert.match(longHtml, /<a href="#sayfa-basi">Başa dön ↑<\/a>/);
  assert.match(
    longMixedHtml,
    /href="#yazili-katkilar">Yazılı \(18\)<\/a>[\s\S]*href="#gorsel-katkilar">Görsel \(1\)<\/a>[\s\S]*href="#ses-makinesi">Ses Makinesi \(1\)<\/a>/,
  );
  assert.match(
    longMixedHtml,
    /id="yazili-katkilar"[\s\S]*id="gorsel-katkilar"[\s\S]*id="ses-makinesi"/,
  );
  assert.match(
    longMixedHtml,
    /<script src="\/assets\/contributor-profile\.js" defer><\/script>/,
  );
  assert.doesNotMatch(longMixedHtml, /<script>(?:.|\n)*enhanceProfileSearch/);
  assert.match(profileScript, /function enhanceProfileSearch\(\)/);
  assert.match(profileScript, /normalize\(row\.textContent\)/);
  assert.match(longMixedHtml, /Eşleşen katkı bulunamadı\./);
  assert.match(longMixedHtml, /aria-live="polite"/);
  const flatSectionHtml = flatMixedHtml.slice(
    flatMixedHtml.indexOf('<section id="katkilari">'),
  );
  assert.match(flatSectionHtml, /id="gorsel-katkilar"/);
  assert.match(flatSectionHtml, /id="ses-makinesi"/);
  assert.match(flatSectionHtml, /id="yazili-katkilar"/);
  assert(
    flatSectionHtml.indexOf('Sayı 46, Sayfa 8 Fotoğrafı')
      < flatSectionHtml.indexOf('Sahte Pelerin')
      && flatSectionHtml.indexOf('Sahte Pelerin')
        < flatSectionHtml.indexOf('Bir Eser'),
  );
  assert.strictEqual(
    createDescription('<h1>Başlık</h1><p>Kısa açıklama.</p>'),
    '',
  );
  assert.strictEqual(createDescription('<p>18</p>'), '');
  assert.strictEqual(createDescription('<p>semihbnw</p>'), '');
  assert.match(
    createDescription(`
      <h1>Başlık</h1>
      <p>Bu açıklama, yayımlanan eserin içeriğini doğru ve anlaşılır biçimde
      tanıtmak için yeterince uzun, özgün ve anlamlı bir metin içerir.</p>
    `, 160, ['Başlık']),
    /^Bu açıklama,/,
  );

  const fundaHtml = renderer.renderProfile({
    ...profile,
    displayName: 'Funda Yaramış',
    recitations: [{
      id: 8,
      magazineIndex: 34,
      startPage: 27,
      pageNumber: 27,
      kind: 'story-narration',
      poemTitle: 'Bir Fasit Daire',
      poetName: 'Oğuzhan Yeşiltuna',
      role: '***',
      anchorId: 'ses-34-27-2',
      publishDateText: 'Ocak 2018',
    }],
  });
  assert.match(
    fundaHtml,
    /Bir Fasit Daire[\s\S]*?<\/a>\s*<span class="contribution-note">adlı hikayede yorumcu dış sesi seslendirdi\.<\/span>/,
  );
});

test('renders contributor profile summaries from the public catalog', () => {
  const reader = openReadOnly(path.join(__dirname, '../content/public.sqlite'));
  const content = new StaticPublicContent(reader);
  reader.close();
  const renderer = new SeoRenderer({
    templatePath: path.join(__dirname, '../client/pages/homepage/index.html'),
    ssrBundlePath: path.join(__dirname, '../build/ssr/does-not-exist.cjs'),
    baseUrl: 'https://galatadergisi.org',
    publicRoot: path.join(__dirname, '../public'),
    mediaMetadata: content.mediaMetadataByPath,
  });
  const profileHtml = (displayName) => {
    const contributor = content.contributors.find((item) => (
      item.displayName === displayName
    ));
    return renderer.renderProfile(content.getContributorProfile(contributor.id));
  };

  const defneHtml = profileHtml('Defne Hadiş');
  assert.match(
    defneHtml,
    /5 yazılı katkı · 13 görsel katkı · 24 kapak görseli · 9 sesli katkı/,
  );
  assert.match(defneHtml, /href="#yazili-katkilar">Yazılı \(5\)<\/a>/);
  assert.match(defneHtml, /href="#gorsel-katkilar">Görsel \(13\)<\/a>/);
  assert.match(defneHtml, /href="#kapak-gorselleri">Kapak \(24\)<\/a>/);
  assert.match(defneHtml, /href="#ses-makinesi">Ses Makinesi \(9\)<\/a>/);
  assert.match(defneHtml, /Yazılı Katkılar <span>\(5\)<\/span>/);
  assert.match(defneHtml, /Görsel Katkılar <span>\(13\)<\/span>/);
  assert.match(defneHtml, /Kapak Görselleri <span>\(24\)<\/span>/);
  assert.match(defneHtml, /Ses Makinesi <span>\(9\)<\/span>/);
  assert.match(defneHtml, /<p class="issue-range">Sayı 9 – Sayı 36<\/p>/);
  assert.match(defneHtml, /class="profile-search"/);
  assert.match(defneHtml, />Katkılarda ara<\/label>/);

  const semihHtml = profileHtml('Semih Bozkurt');
  assert.match(
    semihHtml,
    /47 yazılı katkı · 3 görsel katkı · 9 kapak görseli · 35 sesli katkı/,
  );
  assert.match(semihHtml, /href="#yazili-katkilar">Yazılı \(47\)<\/a>/);
  assert.match(semihHtml, /href="#gorsel-katkilar">Görsel \(3\)<\/a>/);
  assert.match(semihHtml, /href="#kapak-gorselleri">Kapak \(9\)<\/a>/);
  assert.match(semihHtml, /href="#ses-makinesi">Ses Makinesi \(35\)<\/a>/);
  assert.match(semihHtml, /<p class="issue-range">Sayı 1 – Sayı 47<\/p>/);
  assert.match(semihHtml, /class="profile-search"/);
  assert.match(semihHtml, /\(başlık yok\) — Nafizcan Önder/);
  const semihRecitations = semihHtml.slice(semihHtml.indexOf('id="ses-makinesi"'));
  assert(
    semihRecitations.indexOf('href="/dergiler/sayi46">Sayı 46</a>')
      < semihRecitations.indexOf('href="/dergiler/sayi6">Sayı 6</a>'),
  );

  const sertanHtml = profileHtml('Sertan Özen');
  assert.match(sertanHtml, /1 yazılı katkı/);
  assert.match(sertanHtml, /<h2>Katkıları<\/h2>/);
  assert.match(sertanHtml, /class="profile-compact"/);
  assert.doesNotMatch(
    sertanHtml,
    /class="section-nav"|class="profile-search"|class="profile-footer"|<h3>|Başa dön/,
  );
});

test('uses the issue URL and VisualArtwork metadata for cover works', () => {
  const renderer = new SeoRenderer({
    templatePath: path.join(__dirname, '../client/pages/homepage/index.html'),
    ssrBundlePath: path.join(__dirname, '../build/ssr/does-not-exist.cjs'),
    baseUrl: 'https://galatadergisi.org',
  });
  const issue = {
    index: 12,
    publishDateText: 'Ocak 2026',
    publishDate: new Date('2026-01-01T00:00:00Z'),
    thumbnailURL: '/images/sayi12/front.jpg',
  };
  const cover = {
    magazineIndex: 12,
    startPage: 1,
    endPage: 1,
    title: 'Sayı 12 Kapağı',
    type: 'visual',
    kind: 'issue-cover',
    contributors: [{
      id: 8,
      displayName: 'Defne Hadiş',
      slug: 'defne-hadis',
    }],
    recitations: [],
  };
  const workMetadata = renderer.createWorkMetadata(issue, cover, {
    1: '<img src="/images/sayi12/front.jpg" />',
  });
  const issueMetadata = renderer.createIssueMetadata(issue, cover);
  const coverWorkNode = graphNode(
    workMetadata.structuredData,
    (node) => node['@id']
      === 'https://galatadergisi.org/dergiler/sayi12#work',
  );
  const issueCoverNode = graphNode(
    issueMetadata.structuredData,
    (node) => node['@id']
      === 'https://galatadergisi.org/dergiler/sayi12#work',
  );

  assert.strictEqual(workMetadata.canonicalPath, '/dergiler/sayi12');
  assert.strictEqual(coverWorkNode['@type'], 'VisualArtwork');
  assert.strictEqual(workMetadata.image, '/images/sayi12/front.jpg');
  assert.strictEqual(coverWorkNode.creator[0].name, 'Defne Hadiş');
  assert.match(issueMetadata.description, /Kapak: Defne Hadiş/);
  assert.strictEqual(issueCoverNode['@type'], 'VisualArtwork');
  assert.strictEqual(issueMetadata.ogType, 'website');
});

test('uses the full-size artwork image in page-level visual metadata', () => {
  const renderer = new SeoRenderer({
    templatePath: path.join(__dirname, '../client/pages/homepage/index.html'),
    ssrBundlePath: path.join(__dirname, '../build/ssr/does-not-exist.cjs'),
    baseUrl: 'https://galatadergisi.org',
  });
  const metadata = renderer.createWorkMetadata({
    index: 2,
    publishDateText: 'Ocak 2014',
    publishDate: new Date('2014-01-01T00:00:00Z'),
    thumbnailURL: '/images/sayi2/front.jpg',
  }, {
    magazineIndex: 2,
    startPage: 22,
    endPage: 22,
    title: 'Sayı 2, Sayfa 22 Görseli',
    type: 'visual',
    kind: 'page-visual',
    contributors: [{
      id: 8,
      displayName: 'Burak Özkan',
      slug: 'burak-ozkan',
    }],
    recitations: [],
  }, {
    22: `
      <a href="/images/sayi2/1b.jpg"><img src="/images/sayi2/1.jpg" /></a>
      <em>Burak Özkan</em>`,
  });

  assert.strictEqual(metadata.canonicalPath, '/dergiler/sayi2/22');
  assert.strictEqual(metadata.image, '/images/sayi2/1b.jpg');
  const primaryImage = graphNode(
    metadata.structuredData,
    (node) => node['@id']
      === 'https://galatadergisi.org/dergiler/sayi2/22#primaryimage',
  );
  const artwork = graphNode(
    metadata.structuredData,
    (node) => node['@id']
      === 'https://galatadergisi.org/dergiler/sayi2/22#work',
  );
  assert.strictEqual(
    primaryImage.contentUrl,
    'https://galatadergisi.org/images/sayi2/1b.jpg',
  );
  assert.strictEqual(artwork['@type'], 'VisualArtwork');
  assert.strictEqual(artwork.creator[0].name, 'Burak Özkan');
});

test('adds inline artwork and video entities to the parent work metadata', () => {
  const renderer = new SeoRenderer({
    templatePath: path.join(__dirname, '../client/pages/homepage/index.html'),
    ssrBundlePath: path.join(__dirname, '../build/ssr/does-not-exist.cjs'),
    baseUrl: 'https://galatadergisi.org',
  });
  const metadata = renderer.createWorkMetadata({
    index: 44,
    publishDateText: 'Ocak 2024',
    publishDate: new Date('2024-01-01T00:00:00Z'),
    thumbnailURL: '/images/sayi44/front.jpg',
  }, {
    magazineIndex: 44,
    startPage: 19,
    endPage: 20,
    title: 'Bir Yazı',
    type: 'prose',
    kind: 'work',
    contributors: [{
      id: 8,
      displayName: 'Ada Yazar',
      slug: 'ada-yazar',
    }],
    recitations: [],
    media: [{
      pageNumber: 19,
      title: 'Sayı 44, Sayfa 19 Görseli',
      kind: 'illustration',
      mediaPath: '/images/sayi44/gorsel.jpg',
      anchorId: 'gorsel-44-image',
      contributors: [{
        id: 9,
        displayName: 'Funda Yaramış',
        slug: 'funda-yaramis',
      }],
    }, {
      pageNumber: 19,
      title: 'Sayı 44, Sayfa 19 Videosu',
      kind: 'video',
      mediaPath: '/images/sayi44/semih-gorsel.mp4',
      anchorId: 'gorsel-44-video',
      contributors: [{
        id: 10,
        displayName: 'Semih Bozkurt',
        slug: 'semih-bozkurt',
      }],
    }],
  }, {
    19: '<h1 class="mTitle">Bir Yazı</h1><p class="mNesir">Metin</p>',
    20: '<p class="mNesir">Devam.</p>',
  }, {
    magazineIndex: 44,
    startPage: 1,
    endPage: 1,
    title: 'Sayı 44 Kapağı',
    type: 'visual',
    kind: 'issue-cover',
    contributors: [{
      id: 12,
      displayName: 'Kapak Sanatçısı',
      slug: 'kapak-sanatcisi',
    }],
    recitations: [],
    media: [],
  });
  const artwork = graphNode(
    metadata.structuredData,
    (node) => node['@id']
      === 'https://galatadergisi.org/dergiler/sayi44/19#gorsel-44-image',
  );
  const artworkImage = graphNode(
    metadata.structuredData,
    (node) => node['@id']
      === 'https://galatadergisi.org/dergiler/sayi44/19#gorsel-44-image-image',
  );
  const video = graphNode(
    metadata.structuredData,
    (node) => node['@id']
      === 'https://galatadergisi.org/dergiler/sayi44/19#gorsel-44-video',
  );

  assert.strictEqual(metadata.image, '/images/sayi44/front.jpg');
  assert.strictEqual(artwork['@type'], 'VisualArtwork');
  assert.strictEqual(artwork.artform, 'İllüstrasyon');
  assert.strictEqual(
    artworkImage.contentUrl,
    'https://galatadergisi.org/images/sayi44/gorsel.jpg',
  );
  assert.strictEqual(video['@type'], 'VideoObject');
  assert.strictEqual(
    video.contentUrl,
    'https://galatadergisi.org/images/sayi44/semih-gorsel.mp4',
  );
  assert.strictEqual(
    video['@id'],
    'https://galatadergisi.org/dergiler/sayi44/19#gorsel-44-video',
  );
  assert.strictEqual(
    video.isPartOf['@id'],
    'https://galatadergisi.org/dergiler/sayi44/19#work',
  );
  assert.strictEqual(
    mediaContributionPath({
      magazineIndex: 44,
      pageNumber: 19,
      anchorId: 'gorsel-44-video',
    }),
    '/dergiler/sayi44/19#gorsel-44-video',
  );
});

test('renders unique work titles and complete social article metadata', () => {
  const renderer = new SeoRenderer({
    templatePath: path.join(__dirname, '../client/pages/homepage/index.html'),
    ssrBundlePath: path.join(__dirname, '../build/ssr/does-not-exist.cjs'),
    baseUrl: 'https://galatadergisi.org',
    publicRoot: path.join(__dirname, '../public'),
  });
  const metadata = renderer.createWorkMetadata({
    index: 12,
    publishDateText: 'Ocak 2026',
    publishDate: new Date('2026-01-01T00:00:00Z'),
    thumbnailURL: '/images/header-logo.jpg',
  }, {
    magazineIndex: 12,
    startPage: 7,
    endPage: 7,
    title: 'Bir Eser',
    type: 'poetry',
    kind: 'work',
    contributors: [{
      id: 8,
      displayName: 'Ada Yazar',
      slug: 'ada-yazar',
    }],
    recitations: [],
    media: [],
  }, {
    7: '<h1>Bir Eser</h1><p>Metin</p>',
  }, {
    magazineIndex: 12,
    startPage: 1,
    endPage: 1,
    title: 'Sayı 12 Kapağı',
    type: 'visual',
    kind: 'issue-cover',
    contributors: [{
      id: 9,
      displayName: 'Defne Hadiş',
      slug: 'defne-hadis',
    }],
    recitations: [],
    media: [],
  });
  const html = renderer.renderDocument({
    initialMagazines: [],
  }, metadata);

  assert.strictEqual(
    metadata.title,
    'Bir Eser — Ada Yazar | Galata Dergisi, Sayı 12',
  );
  assert.strictEqual(metadata.ogType, 'article');
  assert.match(html, /property="og:type" content="article"/);
  assert.match(html, /property="og:locale" content="tr_TR"/);
  assert.match(
    html,
    /property="og:image:alt" content="Galata Dergisi Sayı 12 kapağı"/,
  );
  assert.match(html, /property="og:image:type" content="image\/jpeg"/);
  assert.match(html, /property="og:image:width" content="\d+"/);
  assert.match(html, /property="og:image:height" content="\d+"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(
    html,
    /name="twitter:title" content="Bir Eser — Ada Yazar \| Galata Dergisi, Sayı 12"/,
  );
  assert.match(
    html,
    /name="twitter:description" content="Bir Eser, Ada Yazar tarafından .* yayımlanan şiir\."/,
  );
  assert.match(
    html,
    /name="twitter:image:alt" content="Galata Dergisi Sayı 12 kapağı"/,
  );
  assert.match(
    html,
    /property="article:published_time" content="2026-01-01T00:00:00.000Z"/,
  );
  assert.doesNotMatch(html, /article:modified_time|dateModified/);
  assert.match(
    html,
    /property="article:section" content="Galata Dergisi Sayı 12"/,
  );
  assert.match(
    html,
    /property="article:author" content="https:\/\/galatadergisi\.org\/katkida-bulunanlar\/8-ada-yazar"/,
  );
  const primaryImage = graphNode(
    metadata.structuredData,
    (node) => node['@id']
      === 'https://galatadergisi.org/dergiler/sayi12/7#primaryimage',
  );
  assert.strictEqual(primaryImage.caption, 'Galata Dergisi Sayı 12 kapağı');
  assert.deepStrictEqual(primaryImage.creator.map((creator) => creator.name), ['Defne Hadiş']);
  assert.strictEqual(primaryImage.copyrightNotice, '© Defne Hadiş');
  assert.match(
    html,
    /rel="alternate" type="application\/atom\+xml" title="Galata Dergisi" href="https:\/\/galatadergisi\.org\/feed\.xml"/,
  );
  assert.doesNotMatch(html, /twitter:creator|hreflang=/);
  assert.doesNotMatch(html, /name="viewport"/);
});

test('models audio parents and multiple original creators without empty authors', () => {
  const renderer = new SeoRenderer({
    templatePath: path.join(__dirname, '../client/pages/homepage/index.html'),
    ssrBundlePath: path.join(__dirname, '../build/ssr/does-not-exist.cjs'),
    baseUrl: 'https://galatadergisi.org',
  });
  const performer = {
    id: 8,
    displayName: 'Ada Yazar',
    slug: 'ada-yazar',
  };
  const metadata = renderer.createWorkMetadata({
    index: 12,
    publishDateText: 'Ocak 2026',
    publishDate: new Date('2026-01-01T00:00:00Z'),
    thumbnailURL: '/images/sayi12/front.jpg',
  }, {
    magazineIndex: 12,
    startPage: 33,
    endPage: 33,
    title: 'Ses Makinesi',
    type: 'audio',
    kind: 'work',
    contributors: [],
    recitations: [{
      pageNumber: 33,
      poemTitle: 'Ortak Şiir',
      poetName: 'Birinci Şair, İkinci Şair',
      mp3Path: '/audio/ortak-siir.mp3',
      oggPath: '/audio/ortak-siir.ogg',
      anchorId: 'ses-12-1',
      contributors: [performer],
    }, {
      pageNumber: 33,
      poemTitle: 'İkinci Kayıt',
      poetName: 'Üçüncü Şair',
      mp3Path: '/audio/ikinci-kayit.mp3',
      oggPath: '/audio/ikinci-kayit.ogg',
      anchorId: 'ses-12-2',
      contributors: [performer],
    }],
    media: [],
  }, {
    33: '<h1>Ses Makinesi</h1>',
  }, {
    magazineIndex: 12,
    startPage: 1,
    endPage: 1,
    title: 'Sayı 12 Kapağı',
    type: 'visual',
    kind: 'issue-cover',
    contributors: [{
      id: 9,
      displayName: 'Defne Hadiş',
      slug: 'defne-hadis',
    }],
    recitations: [],
    media: [],
  });

  assert.strictEqual(
    metadata.title,
    'Ses Makinesi | Galata Dergisi, Sayı 12',
  );
  assert.strictEqual(metadata.ogType, 'website');
  const audioWork = graphNode(
    metadata.structuredData,
    (node) => node['@id']
      === 'https://galatadergisi.org/dergiler/sayi12/33#work',
  );
  const audioNodes = metadata.structuredData['@graph'].filter(
    (node) => node['@type'] === 'AudioObject',
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(audioWork, 'author'),
    false,
  );
  assert.strictEqual(audioNodes.length, 2);
  assert.strictEqual(audioNodes[0].contributor[0].name, 'Ada Yazar');
  assert.deepStrictEqual(
    audioNodes[0].creator.map((person) => person.name),
    ['Birinci Şair', 'İkinci Şair'],
  );
  assert.deepStrictEqual(
    audioNodes[1].creator,
    [{ '@type': 'Person', name: 'Üçüncü Şair' }],
  );
});

test('uses a valid generic Open Graph type for visual works', () => {
  const renderer = new SeoRenderer({
    templatePath: path.join(__dirname, '../client/pages/homepage/index.html'),
    ssrBundlePath: path.join(__dirname, '../build/ssr/does-not-exist.cjs'),
    baseUrl: 'https://galatadergisi.org',
  });
  const visual = renderer.createWorkMetadata({
    index: 12,
    publishDateText: 'Ocak 2026',
    publishDate: new Date('2026-01-01T00:00:00Z'),
    thumbnailURL: '/images/sayi12/front.jpg',
  }, {
    magazineIndex: 12,
    startPage: 22,
    endPage: 22,
    title: 'Bir Görsel',
    type: 'visual',
    kind: 'page-visual',
    contributors: [{
      id: 8,
      displayName: 'Ada Görsel',
      slug: 'ada-gorsel',
    }],
    recitations: [],
    media: [],
  }, {
    22: '<img src="/images/sayi12/front.jpg">',
  });

  assert.strictEqual(visual.ogType, 'website');
});

test('escapes metadata and structured data in server-rendered documents', () => {
  const renderer = new SeoRenderer({
    templatePath: path.join(__dirname, '../client/pages/homepage/index.html'),
    ssrBundlePath: path.join(__dirname, '../build/ssr/does-not-exist.cjs'),
    baseUrl: 'https://galatadergisi.org',
  });
  const html = renderer.renderDocument({
    initialMagazines: [],
  }, {
    title: '<img src=x onerror=alert(1)>',
    description: 'Alıntı " ve <etiket>',
    canonicalPath: '/',
    ogType: 'website',
    structuredData: {
      '@context': 'https://schema.org',
      name: '</script><script>alert(1)</script>',
    },
  });
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<\/script><script>alert\(1\)<\/script>/);
  assert.match(html, /\\u003c\/script\\u003e/);
});

test('server-renders a hydratable reader after the SSR build', () => {
  const ssrBundlePath = path.join(__dirname, '../build/ssr/HomePage.cjs');
  if (!fs.existsSync(ssrBundlePath)) {
    if (process.argv.includes('--require-ssr')) {
      assert.fail('The SSR bundle is missing. Run the production build before this test.');
    }
    return;
  }

  const renderer = new SeoRenderer({
    templatePath: path.join(__dirname, '../client/pages/homepage/index.html'),
    ssrBundlePath,
    baseUrl: 'https://galatadergisi.org',
  });
  const readerProps = {
    initialMagazines: [{
      index: 2,
      publishDateText: 'Ocak 2026',
      thumbnailURL: '/images/2.jpg',
      tableOfContents: 2,
    }],
    initialMagazineIndex: 2,
    initialPages: {
      1: '<img src="/images/2-front.jpg" alt="Ön kapak">',
      2: '<p>İkinci sayfa</p>',
      3: '<p>Üçüncü sayfa</p>',
      4: '<p>Dördüncü sayfa</p>',
      5: '<p>Beşinci sayfa</p>',
      6: '<p>Altıncı sayfa</p>',
      7: '<h1 class="mTitle">Bir Eser</h1><p>Metin</p>',
      8: '<img src="/images/2-back.jpg" alt="Arka kapak">',
    },
    initialAudioPlayers: {
      7: [{
        id: 'audio-player-2-7-1',
        pageNumber: 7,
        tracks: [{
          id: 'kayit-1',
          title: 'Bir Kayıt',
          reader: 'Ada Yazar',
          reciterLinks: [{ name: 'Ada Yazar', href: '/katkida-bulunanlar/1-ada-yazar' }],
          recitationId: 'kayit-1',
          sources: [{ src: '/audio/1.mp3', type: 'audio/mpeg' }],
        }],
      }],
    },
    initialLandingPage: 8,
    initialWorkStartPage: 7,
    initialWorkEndPage: 8,
  };
  const readerMetadata = {
    title: 'Bir Eser | Galata Dergisi',
    description: 'Metin',
    canonicalPath: '/dergiler/sayi2/7',
    ogType: 'article',
    structuredData: { '@context': 'https://schema.org', '@type': 'Article' },
  };
  const html = renderer.renderDocument(readerProps, readerMetadata);
  assert.match(html, /Bir Eser/);
  assert.match(html, /<!--\[[^]*?-->/);
  assert.match(html, /"hydratable":true/);
  assert.match(html, /"initialAudioPlayers"/);
  assert.match(html, /audio-player-2-7-1/);
  const magazineClass = html.match(/<div[^>]*class="([^"]*\bmagazine\b[^"]*)"/);
  assert(magazineClass, 'server-rendered magazine class is missing');
  const magazineClasses = new Set(magazineClass[1].split(/\s+/));
  assert(magazineClasses.has('move-left'), 'direct final page must use the single-page offset');
  assert(magazineClasses.has('last-page'), 'direct final page must use the back-cover transform');
  const middleHtml = renderer.renderDocument({
    ...readerProps,
    initialLandingPage: 7,
  }, readerMetadata);
  const middleMagazineClass = middleHtml.match(/<div[^>]*class="([^"]*\bmagazine\b[^"]*)"/);
  assert(middleMagazineClass, 'server-rendered middle-page magazine class is missing');
  const middleMagazineClasses = new Set(middleMagazineClass[1].split(/\s+/));
  assert(!middleMagazineClasses.has('move-left'), 'middle pages must not use a cover offset');
  assert(!middleMagazineClasses.has('last-page'), 'middle pages must not use the back-cover transform');
  assert.match(html, /rel="canonical" href="https:\/\/galatadergisi.org\/dergiler\/sayi2\/7"/);
  assert.strictEqual((html.match(/<symbol id="galata-icon-/g) || []).length, 21);
  Object.keys(iconLibrary.icons).forEach((name) => {
    assert.match(html, new RegExp(`<symbol id="${iconLibrary.symbolId(name)}"`));
  });
  iconLibrary.toolbarIconNames.forEach((name) => {
    assert.match(html, new RegExp(`<use href="#${iconLibrary.symbolId(name)}"`));
  });
  assert.doesNotMatch(html, /font-awesome|fontawesome|Material\+Icons/i);
});

test('server-renders only the latest and three visible carousel thumbnails', () => {
  const ssrBundlePath = path.join(__dirname, '../build/ssr/HomePage.cjs');
  if (!fs.existsSync(ssrBundlePath)) {
    if (process.argv.includes('--require-ssr')) {
      assert.fail('The SSR bundle is missing. Run the production build before this test.');
    }
    return;
  }

  const renderer = new SeoRenderer({
    templatePath: path.join(__dirname, '../client/pages/homepage/index.html'),
    ssrBundlePath,
    baseUrl: 'https://galatadergisi.org',
  });
  const magazines = Array.from({ length: 7 }, (_, offset) => {
    const index = 7 - offset;
    return {
      index,
      publishDateText: `Sayı ${index}`,
      thumbnailURL: `/images/sayi${index}/thumbnail.jpg`,
      tableOfContents: 2,
    };
  });
  const html = renderer.renderDocument({
    initialMagazines: magazines,
    initialMagazineIndex: null,
    initialPages: null,
    initialLandingPage: 1,
  }, {
    title: 'Galata Dergisi',
    description: 'Dergiler',
    canonicalPath: '/',
    ogType: 'website',
    structuredData: { '@context': 'https://schema.org', '@type': 'WebSite' },
  });
  const bootstrapStart = html.indexOf(
    '<script id="galata-bootstrap" type="application/json">',
  );
  const appHtml = html.slice(html.indexOf('<div id="app">'), bootstrapStart);
  const renderedThumbnails = appHtml.match(
    /<img[^>]+src="\/images\/sayi\d+\/thumbnail\.jpg(?:\?v=[a-f0-9]+)?"[^>]+width="100"[^>]+height="140"/g,
  ) || [];
  const renderedPlaceholders = appHtml.match(
    /--placeholder-image: url\(\/images\/carousel-thumbnail-placeholders\.webp\)/g,
  ) || [];
  const bootstrapMatch = html.match(
    /<script id="galata-bootstrap" type="application\/json">([\s\S]*?)<\/script>/,
  );

  assert.strictEqual(renderedThumbnails.length, 4);
  assert.strictEqual(renderedPlaceholders.length, 4);
  assert.strictEqual((appHtml.match(/href="\/dergiler\/sayi\d+"/g) || []).length, 4);
  assert(bootstrapMatch, 'carousel bootstrap data is missing');
  assert.strictEqual(JSON.parse(bootstrapMatch[1]).initialMagazines.length, 7);
});

(async () => {
  let failures = 0;

  for (const item of tests) {
    try {
      await item.callback();
      console.log(`✓ ${item.name}`);
    } catch (error) {
      failures += 1;
      console.error(`✗ ${item.name}`);
      console.error(error.stack || error.message);
    }
  }

  console.log(`\n${tests.length - failures}/${tests.length} tests passed.`);
  if (failures) process.exitCode = 1;
})();
