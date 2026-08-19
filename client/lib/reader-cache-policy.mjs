export const READER_CACHE_WARM_GRACE_MS = 3_000;

const constrainedConnectionTypes = new Set(['slow-2g', '2g']);

export function shouldWarmReaderCache({ online = true, connection = null } = {}) {
  if (!online || connection?.saveData) return false;
  return !constrainedConnectionTypes.has(connection?.effectiveType);
}
