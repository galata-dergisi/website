// Copyright 2026 Mehmet Baker

export function clamp(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.min(maximum, Math.max(minimum, number));
}

export function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function progressRatio(value, duration) {
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return clamp(Number(value) / total, 0, 1);
}

export function bufferedRanges(buffered) {
  if (!buffered) return [];
  let length;
  try {
    length = Number(buffered.length);
  } catch (_error) {
    return [];
  }
  if (!Number.isInteger(length) || length <= 0) return [];

  const ranges = [];
  for (let index = 0; index < length; index += 1) {
    try {
      const start = Number(buffered.start(index));
      const end = Number(buffered.end(index));
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        continue;
      }
      ranges.push({ start, end });
    } catch (_error) {
      // A malformed interval must not hide the other valid buffered intervals.
    }
  }
  return ranges;
}

export function volumeIcon(volume, muted) {
  const level = muted ? 0 : clamp(volume, 0, 1);
  if (level === 0) return 'audio-volume-muted';
  if (level <= 0.3) return 'audio-volume-low';
  if (level < 0.7) return 'audio-volume-medium';
  return 'audio-volume-high';
}

export function createPlayerState(player) {
  return {
    playerId: player.id,
    selectedIndex: 0,
    currentTime: 0,
    duration: 0,
    bufferedRanges: [],
    volume: 1,
    muted: false,
    playing: false,
    waiting: false,
    error: '',
  };
}

export function wrappedTrackIndex(index, offset, trackCount) {
  const count = Number(trackCount);
  if (!Number.isInteger(count) || count <= 0) return 0;
  return ((Number(index) + Number(offset)) % count + count) % count;
}

export function nextTrackIndex(index, trackCount, naturalCompletion = false) {
  const count = Number(trackCount);
  if (!Number.isInteger(count) || count <= 1) return null;
  if (naturalCompletion) return Number(index) + 1 < count ? Number(index) + 1 : null;
  return wrappedTrackIndex(index, 1, count);
}

export function previousTrackIndex(index, trackCount) {
  return Number(trackCount) > 1
    ? wrappedTrackIndex(index, -1, trackCount)
    : null;
}
