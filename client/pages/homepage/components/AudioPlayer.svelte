<!-- Copyright 2026 Mehmet Baker -->

<script>
  import { onDestroy, onMount } from 'svelte';
  import {
    formatTime,
    progressRatio,
    volumeIcon,
  } from '../../../lib/audio-player-state.mjs';
  import Icon from './Icon.svelte';
  import '../../../styles/audio-player.scss';

  let { player, controller } = $props();

  function getInitialPlayerState() {
    return controller.getState(player.id);
  }

  let playerState = $state.raw(getInitialPlayerState());
  let unsubscribe = null;
  let showTooltip = $state(false);
  let tooltipLeft = $state(0);
  let tooltipTop = $state(0);
  let tooltipTime = $state(0);

  let track = $derived(player.tracks[playerState.selectedIndex] || player.tracks[0]);
  let playedRatio = $derived(progressRatio(playerState.currentTime, playerState.duration));
  let playedWidth = $derived(playedRatio * 230);
  let bufferedSegments = $derived(playerState.bufferedRanges
    .map((range) => {
      const left = progressRatio(range.start, playerState.duration) * 230;
      const right = progressRatio(range.end, playerState.duration) * 230;
      return { left, width: Math.max(0, right - left) };
    })
    .filter((segment) => segment.width > 0));
  let navigatorLeft = $derived(playedRatio * 210);
  let volumeWidth = $derived((playerState.muted ? 0 : playerState.volume) * 75);
  let volumeIconName = $derived(volumeIcon(playerState.volume, playerState.muted));
  let playbackActive = $derived(playerState.playing || playerState.waiting);
  let statusText = $derived(playerState.error || (playerState.waiting ? 'Yükleniyor…' : ''));
  let seekValueText = $derived(
    `${formatTime(playerState.currentTime)} / ${formatTime(playerState.duration)}`,
  );

  onMount(() => {
    unsubscribe = controller.subscribe(player.id, (nextState) => {
      playerState = nextState;
    });
  });

  onDestroy(() => {
    if (unsubscribe) unsubscribe();
  });

  function stopMagazineKeys(event) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight'
      || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.stopPropagation();
    }
  }

  function seek(event) {
    const ratio = Number(event.currentTarget.value) / 1000;
    controller.seek(player.id, ratio * playerState.duration);
  }

  function setVolume(event) {
    controller.setVolume(player.id, Number(event.currentTarget.value) / 100);
  }

  function updateTooltip(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    tooltipLeft = event.clientX - 12;
    tooltipTop = rect.top - 19;
    tooltipTime = ratio * playerState.duration;
    showTooltip = true;
  }
</script>

<div
  class="player_container"
  data-audio-player-view={player.id}
  data-page-turn-gesture-boundary
  aria-busy={playerState.waiting ? 'true' : 'false'}>
  <div class="player_details">
    <div class="song_name" title={track.title}>{track.title}</div>
    <div
      class="song_artist"
      class:player_status_error={Boolean(playerState.error)}
      role="status"
      aria-live="polite"
      aria-atomic="true">
      {#if statusText}
        {statusText}
      {:else if track.reciterLinks.length}
        {#each track.reciterLinks as link, index (link.href)}
          {#if index > 0}, {/if}<a class="contributor-link" href={link.href}>{link.name}</a>
        {/each}
      {:else}
        {track.reader}
      {/if}
    </div>
    <div class="player_track_navigation">
      <button
        type="button"
        class="player_previous"
        aria-label="Önceki kayıt"
        hidden={player.tracks.length < 2}
        onclick={() => controller.previous(player.id)}
        onkeydown={stopMagazineKeys}>
        <Icon name="audio-previous" className="audio-control-icon" />
      </button>
      <button
        type="button"
        class="player_next"
        aria-label="Sonraki kayıt"
        hidden={player.tracks.length < 2}
        onclick={() => controller.next(player.id)}
        onkeydown={stopMagazineKeys}>
        <Icon name="audio-next" className="audio-control-icon" />
      </button>
    </div>
    <div class="horizontal_line"></div>
  </div>

  <button
    type="button"
    class:player_play={!playbackActive}
    class:player_pause={playbackActive}
    aria-label={playbackActive ? 'Duraklat' : 'Oynat'}
    onclick={() => controller.toggle(player.id)}
    onkeydown={stopMagazineKeys}>
    <Icon
      name={playbackActive ? 'audio-pause' : 'audio-play'}
      className="audio-control-icon" />
  </button>

  <div class="player_tracker_cont">
    <div class="player_tracker"></div>
    {#each bufferedSegments as segment (segment.left)}
      <div
        class="player_tracker_loaded"
        style={`left: ${segment.left}px; width: ${segment.width}px`}></div>
    {/each}
    <div class="player_tracker_current" style={`width: ${playedWidth}px`}></div>
    <div class="player_navigator" style={`left: ${navigatorLeft}px`}></div>
    <input
      class="player_seek_input"
      type="range"
      min="0"
      max="1000"
      step="1"
      value={Math.round(playedRatio * 1000)}
      aria-label="Kayıtta ilerle"
      aria-valuetext={seekValueText}
      oninput={seek}
      onkeydown={stopMagazineKeys}
      onpointerenter={updateTooltip}
      onpointermove={updateTooltip}
      onpointerleave={() => showTooltip = false}>
  </div>

  <div class="right_bound"></div>
  <div class="vertical-centering">
    <div class="player_time">{formatTime(playerState.currentTime)}</div>
  </div>

  <button
    type="button"
    class="player_volume_button"
    aria-label={playerState.muted ? 'Sesi aç' : 'Sesi kapat'}
    onclick={() => controller.toggleMute(player.id)}
    onkeydown={stopMagazineKeys}>
    <Icon name={volumeIconName} className="audio-control-icon" />
  </button>

  <div class="volume_cont">
    <div class="player_volume_bar"></div>
    <div class="player_volume_current" style={`width: ${volumeWidth}px`}></div>
    <input
      class="player_volume_input"
      type="range"
      min="0"
      max="100"
      step="1"
      value={Math.round(playerState.volume * 100)}
      aria-label="Ses düzeyi"
      oninput={setVolume}
      onkeydown={stopMagazineKeys}>
  </div>

  <div class="right_bound"></div>
  <div style="clear:both;"></div>

  <div
    class="show_time"
    hidden={!showTooltip}
    aria-hidden="true"
    style={`left: ${tooltipLeft}px; top: ${tooltipTop}px`}>
    <div class="player_show_time put_time">{formatTime(tooltipTime)}</div>
  </div>
</div>
