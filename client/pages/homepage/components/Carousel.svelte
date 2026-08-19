 <!--
   Copyright 2020 Mehmet Baker

   This file is part of galata-dergisi.

   galata-dergisi is free software: you can redistribute it and/or modify
   it under the terms of the GNU General Public License as published by
   the Free Software Foundation, either version 3 of the License, or
   (at your option) any later version.

   galata-dergisi is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
   GNU General Public License for more details.

   You should have received a copy of the GNU General Public License
   along with galata-dergisi. If not, see <https://www.gnu.org/licenses/>.
  -->

<script>
  import { onMount, tick } from 'svelte';
  import MagazineThumbnail from './MagazineThumbnail.svelte';
  import Arrow from './Arrow.svelte';
  import {
    ITEM_STEP,
    TRANSITION_TIMEOUT,
    beginCarouselMove,
    clampFirstItemPosition,
    createCarouselState,
    finishCarouselMove,
    getCarouselWindow,
    rebaseCarouselMove,
    reconcileCarouselState,
  } from './carousel-state.mjs';
  let { items = [], onLoadMagazine = () => {} } = $props();

  function getInitialCarouselState() {
    return createCarouselState(items);
  }

  const initialCarouselState = getInitialCarouselState();
  let carouselState = $state.raw(initialCarouselState);
  let displayedPosition = $state(initialCarouselState.targetFirstItemIndex);
  let buffered = $state(false);
  let previousItems = $state.raw();
  let completionTimer = null;
  let removeLoadListener = null;
  let trackElement = $state();
  let transitionEnabled = $state(true);
  let restartPending = $state(false);
  let transitionRevision = $state(0);
  let destroyed = false;
  let initializedItems = $state(false);



  function clearCompletionTimer() {
    if (completionTimer === null) return;
    clearTimeout(completionTimer);
    completionTimer = null;
  }

  function finishMovement(revision = transitionRevision) {
    if (revision !== transitionRevision) return;
    clearCompletionTimer();
    if (!carouselState.animating) return;
    restartPending = false;
    transitionEnabled = true;
    carouselState = finishCarouselMove(carouselState, items);
    displayedPosition = carouselState.targetFirstItemIndex;
  }

  function scheduleCompletionTimer(revision) {
    clearCompletionTimer();
    completionTimer = setTimeout(
      () => finishMovement(revision),
      TRANSITION_TIMEOUT,
    );
  }

  function readTrackPosition() {
    const fallbackPosition = clampFirstItemPosition(displayedPosition, items);
    if (!trackElement) return fallbackPosition;

    const transform = getComputedStyle(trackElement).transform;
    if (!transform || transform === 'none') return fallbackPosition;

    try {
      const matrix = new DOMMatrixReadOnly(transform);
      return clampFirstItemPosition(-matrix.m41 / ITEM_STEP, items);
    } catch {
      return fallbackPosition;
    }
  }

  async function restoreTransitionAfterSnap(revision) {
    await tick();
    if (destroyed || revision !== transitionRevision) return;
    if (trackElement) trackElement.getBoundingClientRect();
    transitionEnabled = true;
  }

  async function restartMovement(nextState, sourcePosition) {
    const revision = transitionRevision + 1;
    transitionRevision = revision;
    clearCompletionTimer();

    if (!nextState.animating) {
      restartPending = false;
      transitionEnabled = true;
      carouselState = finishCarouselMove(nextState, items);
      displayedPosition = carouselState.targetFirstItemIndex;
      return;
    }

    restartPending = true;
    transitionEnabled = false;
    carouselState = nextState;
    displayedPosition = sourcePosition;

    await tick();
    if (destroyed || revision !== transitionRevision || !trackElement) return;

    trackElement.getBoundingClientRect();
    transitionEnabled = true;
    displayedPosition = nextState.targetFirstItemIndex;

    await tick();
    if (destroyed || revision !== transitionRevision) return;

    restartPending = false;
    scheduleCompletionTimer(revision);
  }

  function handleTrackTransitionEnd(event) {
    if (event.target !== event.currentTarget || event.propertyName !== 'transform') return;
    finishMovement();
  }

  function handleTrackTransitionCancel(event) {
    if (event.target !== event.currentTarget || event.propertyName !== 'transform') return;
    if (restartPending || !carouselState.animating) return;

    const sourcePosition = readTrackPosition();
    const nextState = rebaseCarouselMove(
      carouselState,
      sourcePosition,
      items,
    );
    restartMovement(nextState, sourcePosition);
  }

  function move(direction) {
    const sourcePosition = readTrackPosition();
    const nextState = beginCarouselMove(
      carouselState,
      direction,
      sourcePosition,
      items,
    );
    if (nextState === carouselState) return;

    restartMovement(nextState, sourcePosition);
  }

  function enableBuffer() {
    buffered = true;
    removeLoadListener = null;
  }

  onMount(() => {
    if (document.readyState === 'complete') {
      enableBuffer();
    } else {
      window.addEventListener('load', enableBuffer, { once: true });
      removeLoadListener = () => window.removeEventListener('load', enableBuffer);
    }

    return () => {
      destroyed = true;
      transitionRevision += 1;
      if (removeLoadListener) removeLoadListener();
      clearCompletionTimer();
    };
  });
  $effect(() => {
    if (items !== previousItems) {
      const shouldSnap = initializedItems;
      initializedItems = true;
      previousItems = items;
      transitionRevision += 1;
      clearCompletionTimer();
      carouselState = reconcileCarouselState(carouselState, items);
      displayedPosition = carouselState.targetFirstItemIndex;
      transitionEnabled = !shouldSnap;
      restartPending = false;
      if (shouldSnap) restoreTransitionAfterSnap(transitionRevision);
    }
  });
  let targetFirstItemIndex = $derived(carouselState.targetFirstItemIndex);
  let renderedWindow = $derived(getCarouselWindow(items, carouselState, buffered));
  let leftArrowDisabled = $derived(targetFirstItemIndex === 0);
  let rightArrowDisabled = $derived(targetFirstItemIndex + 3 >= items.length);
</script>

<div class="carousel">
  <div class="left-arrow">
    <Arrow
      disabled={leftArrowDisabled}
      onClick={() => move(-1)}
      onNavigate={({ direction }) => move(direction)}
     />
   </div>

  <div
    class="items"
    class:transition-disabled={!transitionEnabled}
    style="transform: translateX({-displayedPosition * ITEM_STEP}px)"
    bind:this={trackElement}
    ontransitionend={handleTrackTransitionEnd}
    ontransitioncancel={handleTrackTransitionCancel}>
    {#if renderedWindow.startIndex > 0}
      <div
        class="leading-space"
        style="width: {renderedWindow.startIndex * ITEM_STEP}px"></div>
    {/if}
    {#each renderedWindow.entries as entry (entry.item.index)}
      <MagazineThumbnail {...entry.item}
        visible={entry.visible}
        motion={entry.motion}
        carouselItem={true}
        {onLoadMagazine} />
    {/each}
  </div>

  <div class="right-arrow">
    <Arrow
      direction="right"
      disabled={rightArrowDisabled}
      onClick={() => move(1)}
      onNavigate={({ direction }) => move(direction)} />
  </div>
</div>

<style>
  .carousel {
    width: 100%;
    height: 100%;
  }

  .items {
    display: flex;
    transition: transform .3s ease;
    padding-left: 12px;
  }

  .items.transition-disabled {
    transition: none;
  }

  .leading-space {
    flex: 0 0 auto;
    height: 140px;
  }

  .left-arrow, .right-arrow {
    position: absolute;
    top: 50px;
    z-index: 2;
  }

  .left-arrow {
    left: -120px;
  }

  .right-arrow {
    right: -120px;
  }
</style>
