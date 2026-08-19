// Copyright 2026 Mehmet Baker

function hasNavigationModifier(event) {
  return Boolean(
    event?.metaKey
    || event?.ctrlKey
    || event?.shiftKey
    || event?.altKey,
  );
}

/**
 * Returns whether a link activation should use the client-side router.
 * Modified clicks and links with their own browsing context retain native
 * browser behavior.
 */
export function shouldHandleClientNavigation(event, anchor = event?.currentTarget) {
  if (
    !event
    || event.defaultPrevented
    || (event.button !== undefined && event.button !== 0)
    || hasNavigationModifier(event)
    || !anchor
  ) return false;

  if (anchor.hasAttribute?.('download')) return false;
  const target = anchor.getAttribute?.('target')?.trim().toLowerCase();
  return !target || target === '_self';
}

/**
 * Returns whether an arrow-key event should drive application navigation.
 * Browser history and other modified shortcuts retain their native behavior.
 */
export function shouldHandleDirectionalNavigation(event) {
  return Boolean(
    event
    && !event.defaultPrevented
    && !hasNavigationModifier(event)
    && (event.key === 'ArrowLeft' || event.key === 'ArrowRight'),
  );
}
