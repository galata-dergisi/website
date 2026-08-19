// Copyright 2026 Mehmet Baker

import {
  bufferedRanges,
  clamp,
  createPlayerState,
  nextTrackIndex,
  previousTrackIndex,
} from './audio-player-state.mjs';
import { READER_REQUEST_TIMEOUT_MS } from './request-deadline.mjs';

const END_TOLERANCE_SECONDS = 0.25;

const MEDIA_EVENTS = [
  'play',
  'playing',
  'pause',
  'timeupdate',
  'progress',
  'durationchange',
  'loadedmetadata',
  'canplay',
  'seeked',
  'volumechange',
  'waiting',
  'ended',
  'error',
];

function flattenPlayers(audioPlayers) {
  if (Array.isArray(audioPlayers)) return audioPlayers;
  return Object.values(audioPlayers || {}).flat();
}

function cloneState(state) {
  return {
    ...state,
    bufferedRanges: state.bufferedRanges.map((range) => ({ ...range })),
  };
}

export function createAudioPlayerController(audioPlayers, options = {}) {
  const players = new Map(flattenPlayers(audioPlayers).map((player) => [player.id, player]));
  const states = new Map(
    Array.from(players.values()).map((player) => [player.id, createPlayerState(player)]),
  );
  const subscribers = new Map();
  const media = options.audio || new Audio();
  const timers = options.timers || globalThis;
  const playbackTimeoutMs = Number.isFinite(options.playbackTimeoutMs)
    ? Math.max(0, Number(options.playbackTimeoutMs))
    : READER_REQUEST_TIMEOUT_MS;
  let activePlayerId = null;
  let activeTrackId = null;
  let activeSourceUrl = '';
  let activeTrackNeedsReload = false;
  let pendingSeek = null;
  let disposed = false;
  let playRequestSequence = 0;
  let playbackIntent = null;
  let playbackDeadline = null;
  let pendingPlayRequest = null;

  media.preload = 'metadata';

  function playerFor(playerId) {
    const player = players.get(playerId);
    if (!player) throw new Error(`Unknown audio player: ${playerId}`);
    return player;
  }

  function stateFor(playerId) {
    const state = states.get(playerId);
    if (!state) throw new Error(`Unknown audio player state: ${playerId}`);
    return state;
  }

  function notify(playerId) {
    const snapshot = cloneState(stateFor(playerId));
    (subscribers.get(playerId) || []).forEach((subscriber) => subscriber(snapshot));
  }

  function change(playerId, values) {
    Object.assign(stateFor(playerId), values);
    notify(playerId);
  }

  function currentTrack(playerId) {
    const player = playerFor(playerId);
    return player.tracks[stateFor(playerId).selectedIndex] || null;
  }

  function mediaSourceUrl() {
    return String(media.currentSrc || media.src || '');
  }

  function activeMediaMatchesSource() {
    return Boolean(activeSourceUrl) && mediaSourceUrl() === activeSourceUrl;
  }

  function activeMediaIsReadable() {
    return Boolean(activePlayerId)
      && activeMediaMatchesSource()
      && (!('error' in media) || media.error === null);
  }

  function hasPlaybackIntent(playerId) {
    return activePlayerId === playerId
      && activeTrackId === playbackIntent?.trackId
      && activeSourceUrl === playbackIntent?.sourceUrl
      && playbackIntent?.playerId === playerId
      && playbackIntent?.requestSequence === playRequestSequence;
  }

  function clearPlaybackDeadline() {
    if (!playbackDeadline) return;
    const deadline = playbackDeadline;
    playbackDeadline = null;
    timers.clearTimeout(deadline.timer);
  }

  function cancelPendingPlayRequest(requestSequence) {
    if (
      !pendingPlayRequest
      || (requestSequence !== undefined
        && pendingPlayRequest.requestSequence !== requestSequence)
    ) return;
    const request = pendingPlayRequest;
    pendingPlayRequest = null;
    request.resolve({ status: 'cancelled' });
  }

  function clearPlaybackIntent(playerId) {
    if (!playbackIntent || playbackIntent.playerId !== playerId) return;
    const { requestSequence } = playbackIntent;
    playbackIntent = null;
    playRequestSequence += 1;
    clearPlaybackDeadline();
    cancelPendingPlayRequest(requestSequence);
  }

  function mediaPropertyEquals(property, value) {
    return !(property in media) || media[property] === value;
  }

  function canHandlePlaybackEvent(eventName) {
    if (
      !activePlayerId
      || !hasPlaybackIntent(activePlayerId)
      || !activeMediaMatchesSource()
      || !mediaPropertyEquals('paused', false)
      || !mediaPropertyEquals('ended', false)
      || !activeMediaIsReadable()
    ) {
      return false;
    }

    const readyState = Number(media.readyState);
    const futureData = Number(media.HAVE_FUTURE_DATA) || 3;
    if (eventName === 'playing') return readyState >= futureData;
    if (eventName === 'waiting') return readyState < futureData;
    return true;
  }

  function readBufferedRanges() {
    try {
      return bufferedRanges(media.buffered);
    } catch (_error) {
      return [];
    }
  }

  function activeMediaValues() {
    const currentTime = Number(media.currentTime);
    const duration = Number(media.duration);
    return {
      currentTime: Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0,
      duration: Number.isFinite(duration) && duration >= 0 ? duration : 0,
      bufferedRanges: readBufferedRanges(),
    };
  }

  function storeActivePosition() {
    if (!activePlayerId) return;
    const state = stateFor(activePlayerId);
    if (activeMediaIsReadable()) {
      const currentTime = Number(media.currentTime);
      const duration = Number(media.duration);
      if (Number.isFinite(currentTime) && currentTime >= 0) state.currentTime = currentTime;
      if (Number.isFinite(duration) && duration >= 0) state.duration = duration;
      state.bufferedRanges = readBufferedRanges();
    }
    state.volume = clamp(media.volume, 0, 1);
    state.muted = Boolean(media.muted);
  }

  function handlePlaybackTimeout(deadline) {
    if (playbackDeadline !== deadline) return;
    playbackDeadline = null;
    if (
      disposed
      || !hasPlaybackIntent(deadline.playerId)
      || activeTrackId !== deadline.trackId
      || activeSourceUrl !== deadline.sourceUrl
      || playbackIntent?.requestSequence !== deadline.requestSequence
      || !stateFor(deadline.playerId).waiting
    ) return;

    storeActivePosition();
    activeTrackNeedsReload = true;
    clearPlaybackIntent(deadline.playerId);
    media.pause();
    if (typeof media.removeAttribute === 'function') media.removeAttribute('src');
    else media.src = '';
    if (typeof media.load === 'function') media.load();
    change(deadline.playerId, {
      playing: false,
      waiting: false,
      error: 'Kayıt yüklenemedi.',
    });
  }

  function startPlaybackDeadline(playerId) {
    if (!hasPlaybackIntent(playerId) || !stateFor(playerId).waiting) return;
    const deadlineIdentity = {
      playerId,
      trackId: activeTrackId,
      sourceUrl: activeSourceUrl,
      requestSequence: playbackIntent.requestSequence,
    };
    if (
      playbackDeadline
      && playbackDeadline.playerId === deadlineIdentity.playerId
      && playbackDeadline.trackId === deadlineIdentity.trackId
      && playbackDeadline.sourceUrl === deadlineIdentity.sourceUrl
      && playbackDeadline.requestSequence === deadlineIdentity.requestSequence
    ) return;

    clearPlaybackDeadline();
    const deadline = { ...deadlineIdentity, timer: null };
    deadline.timer = timers.setTimeout(
      () => handlePlaybackTimeout(deadline),
      playbackTimeoutMs,
    );
    playbackDeadline = deadline;
  }

  function applyPendingSeek() {
    if (pendingSeek === null || !activePlayerId) return;
    const duration = Number(media.duration);
    const maximum = Number.isFinite(duration) && duration > 0 ? duration : pendingSeek;
    const nextTime = clamp(pendingSeek, 0, maximum);
    try {
      media.currentTime = nextTime;
      pendingSeek = null;
      change(activePlayerId, { currentTime: nextTime });
    } catch (_error) {
      // Some engines reject a seek until metadata arrives; media metadata events retry it.
    }
  }

  function loadActiveTrack(playerId) {
    const state = stateFor(playerId);
    const track = currentTrack(playerId);
    const source = track && track.sources[0];
    if (!source) {
      change(playerId, { playing: false, waiting: false, error: 'Kayıt yüklenemedi.' });
      return false;
    }

    activePlayerId = playerId;
    activeTrackId = track.id;
    pendingSeek = state.currentTime;
    state.bufferedRanges = [];
    media.volume = clamp(state.volume, 0, 1);
    media.muted = Boolean(state.muted);
    media.src = source.src;
    activeSourceUrl = String(media.src || source.src);
    activeTrackNeedsReload = false;
    if (typeof media.load === 'function') media.load();
    applyPendingSeek();
    return true;
  }

  function activate(playerId) {
    const track = currentTrack(playerId);
    if (activePlayerId === playerId && track && activeTrackId === track.id) {
      if (
        !activeTrackNeedsReload
        && (!('error' in media) || media.error === null)
      ) return true;
      clearPlaybackIntent(playerId);
      media.pause();
      return loadActiveTrack(playerId);
    }

    if (activePlayerId) {
      storeActivePosition();
      clearPlaybackIntent(activePlayerId);
      media.pause();
      change(activePlayerId, { playing: false, waiting: false });
    }
    return loadActiveTrack(playerId);
  }

  function emitTrackChange(playerId, reason, updateHash) {
    if (typeof options.onTrackChange !== 'function') return;
    options.onTrackChange({
      player: playerFor(playerId),
      track: currentTrack(playerId),
      reason,
      updateHash,
    });
  }

  async function requestPlay(playerId) {
    if (disposed || !activate(playerId)) return false;
    applyPendingSeek();
    if (playbackIntent) clearPlaybackIntent(playbackIntent.playerId);
    playRequestSequence += 1;
    const requestSequence = playRequestSequence;
    playbackIntent = {
      playerId,
      trackId: activeTrackId,
      sourceUrl: activeSourceUrl,
      requestSequence,
    };
    let resolveCancellation;
    const cancellation = new Promise((resolve) => {
      resolveCancellation = resolve;
    });
    pendingPlayRequest = {
      requestSequence,
      resolve: resolveCancellation,
    };
    change(playerId, { error: '', waiting: true });
    startPlaybackDeadline(playerId);

    let mediaPlay;
    try {
      mediaPlay = Promise.resolve(media.play()).then(
        () => ({ status: 'fulfilled' }),
        () => ({ status: 'rejected' }),
      );
    } catch (_error) {
      mediaPlay = Promise.resolve({ status: 'rejected' });
    }

    const outcome = await Promise.race([mediaPlay, cancellation]);
    if (pendingPlayRequest?.requestSequence === requestSequence) {
      pendingPlayRequest = null;
    }
    if (outcome.status === 'cancelled') return false;
    if (outcome.status === 'fulfilled') {
      return requestSequence === playRequestSequence && hasPlaybackIntent(playerId);
    }

    if (outcome.status === 'rejected') {
      if (requestSequence !== playRequestSequence || !hasPlaybackIntent(playerId)) return false;
      clearPlaybackIntent(playerId);
      change(playerId, {
        playing: false,
        waiting: false,
        error: 'Kayıt oynatılamadı.',
      });
      return false;
    }
    return false;
  }

  async function selectTrack(playerId, index, selectionOptions = {}) {
    const player = playerFor(playerId);
    if (!player.tracks.length) return false;
    const state = stateFor(playerId);
    const wasPlaying = hasPlaybackIntent(playerId);
    const selectedIndex = Math.trunc(clamp(index, 0, player.tracks.length - 1));
    const changedTrack = selectedIndex !== state.selectedIndex;

    if (!changedTrack) {
      emitTrackChange(
        playerId,
        selectionOptions.reason || 'manual',
        selectionOptions.updateHash !== false,
      );
      if (selectionOptions.play === true && !hasPlaybackIntent(playerId)) {
        return requestPlay(playerId);
      }
      return true;
    }

    if (activePlayerId === playerId) {
      storeActivePosition();
      clearPlaybackIntent(playerId);
      media.pause();
      activePlayerId = null;
      activeTrackId = null;
      activeSourceUrl = '';
      activeTrackNeedsReload = false;
      pendingSeek = null;
    }
    change(playerId, {
      selectedIndex,
      currentTime: 0,
      duration: 0,
      bufferedRanges: [],
      playing: false,
      waiting: false,
      error: '',
    });
    emitTrackChange(
      playerId,
      selectionOptions.reason || 'manual',
      selectionOptions.updateHash !== false,
    );

    const continuePlayback = selectionOptions.play === true
      || (selectionOptions.play !== false && wasPlaying);
    if (continuePlayback) return requestPlay(playerId);
    return true;
  }

  async function move(playerId, direction) {
    const player = playerFor(playerId);
    const state = stateFor(playerId);
    const index = direction > 0
      ? nextTrackIndex(state.selectedIndex, player.tracks.length)
      : previousTrackIndex(state.selectedIndex, player.tracks.length);
    if (index === null) return false;
    return selectTrack(playerId, index, { reason: direction > 0 ? 'next' : 'previous' });
  }

  function seek(playerId, value) {
    const state = stateFor(playerId);
    const maximum = state.duration > 0 ? state.duration : Number(value) || 0;
    const currentTime = clamp(value, 0, maximum);
    if (activePlayerId === playerId) {
      try {
        media.currentTime = currentTime;
        pendingSeek = null;
      } catch (_error) {
        pendingSeek = currentTime;
      }
    }
    change(playerId, { currentTime });
  }

  function setVolume(playerId, value) {
    const volume = clamp(value, 0, 1);
    if (activePlayerId === playerId) media.volume = volume;
    change(playerId, { volume });
  }

  function setMuted(playerId, muted) {
    if (activePlayerId === playerId) media.muted = Boolean(muted);
    change(playerId, { muted: Boolean(muted) });
  }

  function pausePlayer(playerId) {
    if (activePlayerId === playerId) {
      clearPlaybackIntent(playerId);
      media.pause();
    }
    change(playerId, { playing: false, waiting: false });
  }

  function selectHash(hash) {
    const target = String(hash || '').replace(/^#/, '');
    if (!target) return null;
    for (const player of players.values()) {
      const index = player.tracks.findIndex((track) => track.recitationId === target);
      if (index >= 0) {
        selectTrack(player.id, index, { play: false, reason: 'hash', updateHash: false });
        return { playerId: player.id, trackIndex: index };
      }
    }
    return null;
  }

  async function handleEnded() {
    if (!activePlayerId) return;
    if (!hasPlaybackIntent(activePlayerId)) return;
    if (!activeMediaIsReadable()) return;
    if (!mediaPropertyEquals('ended', true)) return;
    const playerId = activePlayerId;
    const state = stateFor(playerId);
    const currentTime = Number(media.currentTime);
    const duration = Number(media.duration);
    // Some media engines emit `ended` while seeking into an unbuffered range
    // or while replacing a source. Only advance when the active source has
    // actually reached its end.
    if (
      !Number.isFinite(currentTime)
      || !Number.isFinite(duration)
      || duration <= 0
      || currentTime < duration - END_TOLERANCE_SECONDS
    ) {
      const mediaValues = activeMediaValues();
      if (mediaPropertyEquals('paused', true)) {
        pendingSeek = mediaValues.currentTime;
        clearPlaybackIntent(playerId);
        change(playerId, {
          ...mediaValues,
          playing: false,
          waiting: false,
        });
        return;
      }
      change(playerId, mediaValues);
      return;
    }

    const index = nextTrackIndex(state.selectedIndex, playerFor(playerId).tracks.length, true);
    if (index === null) {
      clearPlaybackIntent(playerId);
      change(playerId, { playing: false, waiting: false });
      return;
    }
    await selectTrack(playerId, index, { play: true, reason: 'ended' });
  }

  function handleError() {
    if (!activePlayerId) return;
    if ('error' in media && media.error === null) return;
    if (!activeMediaMatchesSource()) return;
    const playerId = activePlayerId;
    clearPlaybackIntent(playerId);
    change(playerId, {
      playing: false,
      waiting: false,
      error: 'Kayıt yüklenemedi.',
    });
  }

  const handlers = {
    play: () => canHandlePlaybackEvent('play') && change(activePlayerId, { error: '' }),
    playing: () => {
      if (!canHandlePlaybackEvent('playing')) return false;
      clearPlaybackDeadline();
      change(activePlayerId, {
        playing: true,
        waiting: false,
        error: '',
      });
      return true;
    },
    pause: () => {
      if (!activePlayerId || !mediaPropertyEquals('paused', true)) return;
      const playerId = activePlayerId;
      if (
        hasPlaybackIntent(playerId)
        && activeMediaMatchesSource()
        && mediaPropertyEquals('ended', true)
      ) {
        return;
      }
      clearPlaybackIntent(playerId);
      change(playerId, { playing: false, waiting: false });
    },
    timeupdate: () => activeMediaIsReadable() && change(activePlayerId, {
      currentTime: Number(media.currentTime) || 0,
      bufferedRanges: readBufferedRanges(),
    }),
    progress: () => activeMediaIsReadable() && change(activePlayerId, {
      bufferedRanges: readBufferedRanges(),
    }),
    durationchange: () => {
      if (!activeMediaIsReadable()) return;
      change(activePlayerId, activeMediaValues());
      applyPendingSeek();
    },
    loadedmetadata: () => {
      if (!activeMediaIsReadable()) return;
      change(activePlayerId, activeMediaValues());
      applyPendingSeek();
    },
    canplay: () => activeMediaIsReadable() && change(activePlayerId, activeMediaValues()),
    seeked: () => activeMediaIsReadable() && change(activePlayerId, activeMediaValues()),
    volumechange: () => activePlayerId && change(activePlayerId, {
      volume: clamp(media.volume, 0, 1),
      muted: Boolean(media.muted),
    }),
    waiting: () => {
      if (!canHandlePlaybackEvent('waiting')) return false;
      const playerId = activePlayerId;
      change(playerId, { waiting: true });
      startPlaybackDeadline(playerId);
      return true;
    },
    ended: handleEnded,
    error: handleError,
  };

  MEDIA_EVENTS.forEach((event) => media.addEventListener(event, handlers[event]));

  return {
    subscribe(playerId, subscriber) {
      playerFor(playerId);
      if (!subscribers.has(playerId)) subscribers.set(playerId, new Set());
      subscribers.get(playerId).add(subscriber);
      subscriber(cloneState(stateFor(playerId)));
      return () => {
        const playerSubscribers = subscribers.get(playerId);
        if (!playerSubscribers) return;
        playerSubscribers.delete(subscriber);
        if (playerSubscribers.size === 0) subscribers.delete(playerId);
      };
    },
    getState: (playerId) => cloneState(stateFor(playerId)),
    getPlayer: playerFor,
    getActivePlayerId: () => activePlayerId,
    play: requestPlay,
    pause: pausePlayer,
    toggle(playerId) {
      const state = stateFor(playerId);
      if (activePlayerId === playerId && (state.playing || state.waiting)) {
        pausePlayer(playerId);
        return Promise.resolve(true);
      }
      return requestPlay(playerId);
    },
    next: (playerId) => move(playerId, 1),
    previous: (playerId) => move(playerId, -1),
    selectTrack,
    selectHash,
    seek,
    setVolume,
    setMuted,
    toggleMute(playerId) {
      setMuted(playerId, !stateFor(playerId).muted);
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      if (playbackIntent) clearPlaybackIntent(playbackIntent.playerId);
      else {
        playRequestSequence += 1;
        clearPlaybackDeadline();
        cancelPendingPlayRequest();
      }
      MEDIA_EVENTS.forEach((event) => media.removeEventListener(event, handlers[event]));
      media.pause();
      if (typeof media.removeAttribute === 'function') media.removeAttribute('src');
      else media.src = '';
      if (typeof media.load === 'function') media.load();
      if (activePlayerId) {
        Object.assign(stateFor(activePlayerId), { playing: false, waiting: false });
      }
      subscribers.clear();
      activePlayerId = null;
      activeTrackId = null;
      activeSourceUrl = '';
      activeTrackNeedsReload = false;
    },
  };
}
