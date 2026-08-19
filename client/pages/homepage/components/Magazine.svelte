<!--
  Copyright 2020 Mehmet Baker
  Copyright 2021 Zeynep Kazu

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
  import { mount, onDestroy, onMount, unmount } from 'svelte';
  import { fly } from 'svelte/transition';
  import Utils from '../../../lib/Utils.js';
  import AudioPlayer from './AudioPlayer.svelte';
  import Icon from './Icon.svelte';
  import { createAudioPlayerController } from '../../../lib/audio-player-controller.mjs';
  import { createAudioPlayerViewManager } from '../../../lib/audio-player-view-manager.mjs';
  import { shouldHandleClientNavigation } from '../../../lib/link-navigation.mjs';
  import { PageTurn } from '../../../lib/page-turn.mjs';
  import {
    createPageMediaCoordinator,
    PAGE_MEDIA_STATE,
  } from '../../../lib/page-media-state.mjs';
  import { fetchMagazinePages } from '../../../lib/reader-load.mjs';
  import {
    homeHistoryState,
    initialIssueHistoryActions,
    issueHistoryState,
    readerIssueFallbackTitle,
    readerIssueRoute,
    READER_HISTORY_ACTION,
    shouldReturnToHome,
    updateReaderHistory,
  } from '../../../lib/reader-history.mjs';
  import {
    applySeoDocument,
    applyOptionalHomeSeoDocument,
    loadIssueSeo,
    resolveIssueSeoPage,
  } from '../../../lib/seo-head.mjs';

  let {
    index,
    publishDateText,
    tableOfContents,
    landingPage = 1,
    initialPages = null,
    initialAudioPlayers = null,
    initialWorkStartPage = null,
    initialWorkEndPage = null,
    landingHash = '',
    initialHistoryAction = 'replace',
    returnToHome = false,
    onLoadMagazine = () => {},
    onUnloadMagazine = () => {},
    onOutroEnd = () => {},
  } = $props();

  function createInitialState() {
    const pages = initialPages;
    const firstPage = landingPage;
    const historyActions = initialIssueHistoryActions(initialHistoryAction);
    return {
      pages,
      audioPlayers: initialAudioPlayers || {},
      numberOfPages: pages ? Object.keys(pages).length : null,
      renderedPageNumbers: pages
        ? Object.keys(pages)
          .map(Number)
          .filter((page) => (
            page >= Number(initialWorkStartPage || firstPage)
            && page <= Number(initialWorkEndPage || firstPage)
          ))
          .sort((left, right) => left - right)
        : [],
      firstPage,
      historyAction: historyActions.route,
      seoHistoryAction: historyActions.seo,
    };
  }

  const initialState = createInitialState();
  let magazine = $state();

  function shouldCenterSinglePage(page, pageCount) {
    const pageNumber = Number(page);
    const totalPages = Number(pageCount);
    return pageNumber === 1
      || (Number.isInteger(totalPages) && totalPages > 0 && pageNumber === totalPages);
  }

  let magazinePageContents = $state.raw(initialState.pages);
  let magazineAudioPlayers = $state.raw(initialState.audioPlayers);
  let numberOfPages = $state(initialState.numberOfPages);
  const initialRenderedPageNumbers = initialState.renderedPageNumbers;

  // A single visible cover is offset so it remains centered in the reader.
  let moveLeft = $state(shouldCenterSinglePage(
    initialState.firstPage,
    initialState.numberOfPages,
  ));

  let currentPage = $state(initialState.firstPage);
  let navigationPages = $derived.by(() => {
    if (typeof currentPage !== 'number' || typeof numberOfPages !== 'number') {
      return { next: currentPage, previous: currentPage };
    }
    if (currentPage % 2 === 0) {
      return {
        next: Math.min(numberOfPages, currentPage + 2),
        previous: Math.max(1, currentPage - 1),
      };
    }
    return {
      next: Math.min(numberOfPages, currentPage + 1),
      previous: Math.max(1, currentPage - 2),
    };
  });
  let nextPage = $derived(navigationPages.next);
  let prevPage = $derived(navigationPages.previous);
  const READER_LOAD_STATE = Object.freeze({
    LOADING: 'loading',
    READY: 'ready',
    ERROR: 'error',
  });
  let readerLoadState = $state(
    initialState.pages ? READER_LOAD_STATE.READY : READER_LOAD_STATE.LOADING,
  );
  let readerReady = $state(false);
  let previousNavigationDisabled = $derived(!readerReady || currentPage === 1);
  let nextNavigationDisabled = $derived(!readerReady || nextPage === currentPage);

  let pageTurn = null;
  let seoIndex = null;
  let seoIndexPromise = null;
  let navigationSequence = 0;
  let destroyed = false;
  let pendingNavigationHash = '';
  let pendingNavigationPage = null;
  const initialSeoHistoryAction = initialState.seoHistoryAction;
  let pendingNavigationHistoryAction = initialSeoHistoryAction;
  let turnScheduledNavigation = false;
  let audioController = null;
  let audioPlayerViewManager = null;
  let audioPlayersById = new Map();
  let pageMediaCoordinator = null;
  let pageRequestController = null;
  let pageRequestSequence = 0;
  let seoRequestController = null;

  function isVisibleContent(content) {
    if (/<img\b/i.test(content || '')) return true;
    return String(content || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .trim().length > 0;
  }

  function renderPageContent(page, sourceContent) {
    let content = sourceContent || '';

    if (page !== 1 && page !== numberOfPages) {
      if (isVisibleContent(content)) {
        content += [
          '<div class="mPageNum"><div class="pageNumLeft"></div>',
          `<div class="pageNum">${page}</div>`,
          '<div class="pageNumRight"></div></div>',
        ].join('');
        content = `<div class="mMargin">${content}</div>`;
      }

      content = `<div class="gradient">${content}</div>`;
    }

    return content;
  }

  function pageContainsMedia(sourceContent) {
    return /<(?:img|video)\b/i.test(String(sourceContent || ''));
  }

  function pageMediaOverlay(pageElement) {
    let overlay = pageElement.querySelector('[data-page-media-state]');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.className = 'page-media-state';
    overlay.dataset.pageMediaState = '';

    const loader = document.createElement('div');
    loader.className = 'loader';
    loader.append(
      document.createElement('div'),
      document.createElement('div'),
      document.createElement('div'),
      document.createElement('div'),
    );
    const message = document.createElement('p');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Tekrar dene';
    retry.dataset.pageTurnGestureBoundary = '';
    overlay.append(loader, message, retry);
    pageElement.append(overlay);
    return overlay;
  }

  function renderPageMediaState(pageElement, { pageNumber, state, retry }) {
    const existingOverlay = pageElement.querySelector('[data-page-media-state]');
    if (state === PAGE_MEDIA_STATE.READY) {
      existingOverlay?.remove();
      return;
    }

    const overlay = existingOverlay || pageMediaOverlay(pageElement);
    const loading = state === PAGE_MEDIA_STATE.LOADING;
    overlay.classList.toggle('error', !loading);
    overlay.querySelector('.loader').hidden = !loading;
    overlay.querySelector('p').textContent = loading
      ? `Sayfa ${pageNumber} yükleniyor…`
      : 'Sayfa medyası yüklenemedi.';
    const retryButton = overlay.querySelector('button');
    retryButton.hidden = loading;
    retryButton.onclick = retry;
  }

  function initializePageMediaCoordinator() {
    if (pageMediaCoordinator) pageMediaCoordinator.dispose();
    pageMediaCoordinator = createPageMediaCoordinator({
      onStateChange: renderPageMediaState,
    });
  }

  function disposePageMedia() {
    if (pageMediaCoordinator) pageMediaCoordinator.dispose();
    pageMediaCoordinator = null;
  }

  // Adds the pages that the book will need
  function addPage(page, engine = pageTurn) {
    if (!engine.hasPage(page)) {
      const element = document.createElement('div');
      element.className = "page " + (page % 2 === 0 ? 'even' : 'odd');
      element.id = "page-" + page;
      element.innerHTML = '<div class="loader"><div></div><div></div><div></div><div></div></div>';

      engine.addPage(page, element);

      element.innerHTML = renderPageContent(page, magazinePageContents[page]);
      if (audioPlayerViewManager) audioPlayerViewManager.mountWithin(element);
      if (pageMediaCoordinator) pageMediaCoordinator.watchPage(element, page);

      // Bind a clicks to event handler
      const anchors = element.querySelectorAll('a');

      for (let i = 0; i < anchors.length; ++i) {
        anchors[i].addEventListener('click', onAnchorClick);
      }
    }
  }

  function pagesShareView(left, right) {
    const page = Number(right);
    if (Number(left) === page) return true;
    if (page === 1) return false;
    return page % 2 === 0
      ? Number(left) === page + 1
      : Number(left) === page - 1;
  }

  function onAudioTrackChange({ player, track, updateHash }) {
    if (
      !updateHash
      || !track.recitationId
      || !pagesShareView(currentPage, player.pageNumber)
    ) return;
    scheduleSeoRoute(
      player.pageNumber,
      `#${track.recitationId}`,
      READER_HISTORY_ACTION.REPLACE,
    );
  }

  function initializeAudioController() {
    audioPlayersById = new Map(
      Object.values(magazineAudioPlayers).flat().map((player) => [player.id, player]),
    );
    audioController = createAudioPlayerController(magazineAudioPlayers, {
      onTrackChange: onAudioTrackChange,
    });
    audioPlayerViewManager = createAudioPlayerViewManager({
      root: magazine,
      playersById: audioPlayersById,
      createView: (target, player) => mount(AudioPlayer, {
        target,
        props: { player, controller: audioController },
      }),
      destroyView: (view) => void unmount(view),
    });
    audioController.selectHash(landingHash || window.location.hash);
  }

  export function disposeAudio() {
    if (audioPlayerViewManager) audioPlayerViewManager.dispose();
    audioPlayerViewManager = null;
    if (audioController) audioController.destroy();
    audioController = null;
  }

  function commitSeoRoute(page, hash, sequence, historyAction) {
    if (destroyed || sequence !== navigationSequence || !seoIndex) return false;
    try {
      const resolved = resolveIssueSeoPage(seoIndex, page, hash);
      const seoDocument = resolved.document;
      applySeoDocument(document, seoDocument);
      updateReaderHistory(
        window.history,
        historyAction,
        issueHistoryState(index, page, {
          previousState: historyAction === READER_HISTORY_ACTION.REPLACE
            ? window.history.state
            : null,
          returnToHome,
        }),
        seoDocument.title,
        resolved.route,
      );
      return true;
    } catch (error) {
      console.trace(error);
      return false;
    }
  }

  function commitFallbackRoute(page, hash, sequence, historyAction) {
    if (destroyed || sequence !== navigationSequence) return false;
    const title = readerIssueFallbackTitle(index, publishDateText);
    document.title = title;
    try {
      updateReaderHistory(
        window.history,
        historyAction,
        issueHistoryState(index, page, {
          previousState: historyAction === READER_HISTORY_ACTION.REPLACE
            ? window.history.state
            : null,
          returnToHome,
        }),
        title,
        readerIssueRoute(index, page, hash),
      );
      return true;
    } catch (error) {
      console.trace(error);
      return false;
    }
  }

  function scheduleSeoRoute(
    page,
    hash = '',
    historyAction = READER_HISTORY_ACTION.REPLACE,
  ) {
    navigationSequence += 1;
    const sequence = navigationSequence;
    if (seoIndex) {
      if (!commitSeoRoute(page, hash, sequence, historyAction)) {
        commitFallbackRoute(page, hash, sequence, historyAction);
      }
      return;
    }

    commitFallbackRoute(page, hash, sequence, historyAction);
    if (!seoIndexPromise) return;
    seoIndexPromise.then((loaded) => {
      if (destroyed || sequence !== navigationSequence) return;
      if (!loaded) return;
      const refinementHistoryAction = historyAction === READER_HISTORY_ACTION.NONE
        ? READER_HISTORY_ACTION.NONE
        : READER_HISTORY_ACTION.REPLACE;
      if (!commitSeoRoute(page, hash, sequence, refinementHistoryAction)) {
        commitFallbackRoute(page, hash, sequence, refinementHistoryAction);
      }
    });
  }

  function beginSeoLoad() {
    if (seoRequestController) seoRequestController.abort();
    const controller = new AbortController();
    seoRequestController = controller;
    seoIndexPromise = loadIssueSeo(index, { signal: controller.signal })
      .then((loaded) => {
        if (destroyed) return null;
        seoIndex = loaded;
        return loaded;
      })
      .catch((error) => {
        if (!destroyed && error?.name !== 'AbortError') {
          console.warn(`SEO metadata for issue ${index} could not be loaded.`, error);
        }
        return null;
      })
      .finally(() => {
        if (seoRequestController === controller) seoRequestController = null;
      });
  }

  function onAnchorClick(e) {
    let { target } = e;

    if (target.nodeName !== 'A') {
      target = target.closest('a');
    }

    if (!target) {
      return;
    }

    const { href } = target;
    const indexAndPage = Utils.getMagazineIndexAndPageFromURL(href);

    // `href` is a magazine URL
    if (
      indexAndPage !== null
      && shouldHandleClientNavigation(e, target)
    ) {
      e.preventDefault();
      e.stopPropagation();
      onLoadMagazine({
        ...indexAndPage,
        hash: new URL(href).hash,
      });
    }
  }

  function handleReaderNavigation(event, page, disabled) {
    if (disabled) {
      event.preventDefault();
      return;
    }
    if (!shouldHandleClientNavigation(event, event.currentTarget)) return;
    event.preventDefault();
    goToPage(page);
  }

  /** Makes sure that `page` is ready in the page-turn engine. */
  function ensureRange(page, engine = pageTurn) {
    if (!engine) return;

    // Gets the range of pages that the magazine needs right now
    const range = engine.range(page);
    if (
      initialWorkStartPage
      && initialWorkEndPage
      && page >= initialWorkStartPage
      && page <= initialWorkEndPage
    ) {
      range[0] = Math.min(range[0], Number(initialWorkStartPage));
      range[1] = Math.max(range[1], Number(initialWorkEndPage));
    }
    currentPage = page;

    // Check if each page is within the book
    for (page = range[0]; page <= range[1]; page++) {
      addPage(page, engine);
    }
  }

  function cancelPageRequest() {
    pageRequestSequence += 1;
    if (pageRequestController) pageRequestController.abort();
    pageRequestController = null;
  }

  function cancelSeoRequest() {
    if (seoRequestController) seoRequestController.abort();
    seoRequestController = null;
  }

  export function cancelPendingRequests() {
    cancelPageRequest();
    cancelSeoRequest();
  }

  function initializeReader() {
    if (destroyed || readerReady || pageTurn) return;

    // Remove server-rendered or failed-attempt content immediately before
    // PageTurn takes ownership of the container.
    magazine.innerHTML = '';
    initializeAudioController();
    initializePageMediaCoordinator();
    numberOfPages = Object.keys(magazinePageContents).length;
    moveLeft = shouldCenterSinglePage(currentPage, numberOfPages);

    pageTurn = new PageTurn(magazine, {
      pageCount: numberOfPages,
      elevation: 50,
      width: 1000,
      height: 700,
      duration: 600,
      onTurning: function(e, page, view, engine) {
        const historyAction = pendingNavigationHistoryAction;
        pendingNavigationHistoryAction = READER_HISTORY_ACTION.REPLACE;
        ensureRange(page, engine);
        turnScheduledNavigation = true;
        if (
          pendingNavigationPage === null
          || !pagesShareView(page, pendingNavigationPage)
        ) {
          pendingNavigationPage = page;
          pendingNavigationHash = '';
        }
        scheduleSeoRoute(pendingNavigationPage, pendingNavigationHash, historyAction);
      },
      onTurned: function(e, page) {
        moveLeft = shouldCenterSinglePage(page, numberOfPages);
        // PageTurn caches page elements after removing them from the DOM.
        // Reconcile their Svelte views whenever that cached range changes.
        if (audioPlayerViewManager) audioPlayerViewManager.reconcile();
      },
    });
    readerReady = true;

    if (landingPage !== 1) {
      goToPage(landingPage, landingHash, initialSeoHistoryAction);
      readerLoadState = READER_LOAD_STATE.READY;
      return;
    }

    ensureRange(landingPage);
    turnScheduledNavigation = false;
    pendingNavigationHash = landingHash;
    pendingNavigationPage = landingPage;
    pendingNavigationHistoryAction = initialSeoHistoryAction;
    pageTurn.goToPage(landingPage);
    if (!turnScheduledNavigation) {
      pendingNavigationHistoryAction = READER_HISTORY_ACTION.REPLACE;
      scheduleSeoRoute(landingPage, landingHash, initialSeoHistoryAction);
    }
    readerLoadState = READER_LOAD_STATE.READY;
  }

  async function loadReader() {
    if (destroyed || readerReady || pageTurn) return;

    readerLoadState = READER_LOAD_STATE.LOADING;
    if (pageRequestController) pageRequestController.abort();
    pageRequestSequence += 1;
    const requestSequence = pageRequestSequence;
    const controller = magazinePageContents ? null : new AbortController();
    pageRequestController = controller;

    try {
      if (!magazinePageContents) {
        const loadedPages = await fetchMagazinePages(index, {
          signal: controller.signal,
        });
        if (destroyed || requestSequence !== pageRequestSequence) return;
        magazinePageContents = loadedPages.pages;
        magazineAudioPlayers = loadedPages.audioPlayers;
      }
      if (destroyed || requestSequence !== pageRequestSequence) return;
      initializeReader();
    } catch (error) {
      if (
        destroyed
        || requestSequence !== pageRequestSequence
        || error?.name === 'AbortError'
      ) return;

      console.trace(error);
      readerReady = false;
      if (pageTurn) pageTurn.destroy();
      pageTurn = null;
      disposeAudio();
      disposePageMedia();
      if (magazine) magazine.innerHTML = '';
      readerLoadState = READER_LOAD_STATE.ERROR;
    } finally {
      if (requestSequence === pageRequestSequence) pageRequestController = null;
    }
  }

  onDestroy(() => {
    destroyed = true;
    navigationSequence += 1;
    cancelPendingRequests();
    disposeAudio();
    disposePageMedia();
    const anchors = magazine ? magazine.querySelectorAll('a') : [];

    for (let i = 0; i < anchors.length; ++i) {
      anchors[i].removeEventListener('click', onAnchorClick);
    }

    if (pageTurn) pageTurn.destroy();
    pageTurn = null;
    readerReady = false;
  });

  onMount(() => {
    try {
      const initialTitle = magazinePageContents
        ? document.title
        : readerIssueFallbackTitle(index, publishDateText);
      if (!magazinePageContents) document.title = initialTitle;
      updateReaderHistory(
        window.history,
        initialHistoryAction,
        issueHistoryState(index, landingPage, {
          previousState: initialHistoryAction === READER_HISTORY_ACTION.REPLACE
            ? window.history.state
            : null,
          returnToHome,
        }),
        initialTitle,
        readerIssueRoute(index, landingPage, landingHash),
      );
      beginSeoLoad();
      scheduleSeoRoute(landingPage, landingHash, initialSeoHistoryAction);
      void loadReader();
    } catch (ex) {
      console.trace(ex);
      readerLoadState = READER_LOAD_STATE.ERROR;
    }
  });

  export function goToPage(
    pageNum,
    hash = '',
    historyAction = READER_HISTORY_ACTION.REPLACE,
  ) {
    if (!readerReady || !pageTurn) return false;
    pageNum = Number(pageNum);
    ensureRange(pageNum);
    if (hash && audioController) audioController.selectHash(hash);
    turnScheduledNavigation = false;
    pendingNavigationHash = hash;
    pendingNavigationPage = pageNum;
    pendingNavigationHistoryAction = historyAction;
    pageTurn.goToPage(pageNum);
    if (!turnScheduledNavigation) {
      pendingNavigationHistoryAction = READER_HISTORY_ACTION.REPLACE;
      scheduleSeoRoute(pageNum, hash, historyAction);
    }
    return true;
  }

  export function goToNextPage() {
    return goToPage(nextPage);
  }

  export function goToPreviousPage() {
    return goToPage(prevPage);
  }

  export function goToHomepage(historyAction = READER_HISTORY_ACTION.PUSH) {
    cancelPendingRequests();
    navigationSequence += 1;
    const homeTitle = applyOptionalHomeSeoDocument(document, seoIndex?.home);
    try {
      updateReaderHistory(
        window.history,
        historyAction,
        homeHistoryState(),
        homeTitle,
        '/',
      );
    } catch (error) {
      console.warn('Homepage history could not be updated.', error);
    }
    onUnloadMagazine();
  }

  function close() {
    cancelPendingRequests();
    if (shouldReturnToHome(window.history.state)) {
      navigationSequence += 1;
      window.history.back();
      return;
    }
    goToHomepage(READER_HISTORY_ACTION.PUSH);
  }

  function shareOnFacebook() {
    window.open('https://www.facebook.com/sharer.php?' +
      'u=' + encodeURIComponent(`https://galatadergisi.org/dergiler/sayi${index}/${currentPage}`) +
      '&t=' + encodeURIComponent(`Galata Dergisi - Sayı ${index} (${publishDateText})`));
  }

  function shareOnTwitter() {
    const url = encodeURIComponent(`https://galatadergisi.org/dergiler/sayi${index}/${currentPage}`);
    const shareText = encodeURIComponent(`Galata Dergisi - Sayı ${index} (${publishDateText})`);

    window.open(`https://twitter.com/intent/tweet?original_referer=${url}&url=${url}&text=${shareText}`);
  }
</script>

<style lang="scss">
  .container {
    position: absolute !important;
    top: 90px;
    z-index: 2;
    height: 750px;
    width: 100%;
    overflow: hidden;
    display: flex;
    justify-content: center;
  }

  .center {
    position: absolute;
    height: 720px;
    padding-top: 20px;
  }

  .reader-load-page {
    align-items: center;
    background: white;
    box-shadow: 0 0 5px rgba(0,0,0,0.2);
    display: flex;
    flex-direction: column;
    height: 700px;
    justify-content: center;
    left: 0;
    position: absolute;
    top: 20px;
    width: 500px;
    z-index: 1;

    &.move-left {
      left: 50%;
      transform: translateX(-250px);
    }

    :global(.loader) {
      flex: 0 0 80px;
      left: auto;
      position: relative;
      top: auto;
    }

    p {
      color: #4d4f53;
      font-size: 18px;
      margin: 20px 30px 0;
      text-align: center;
    }

    button {
      background: #698145;
      border: 0;
      border-radius: 3px;
      color: white;
      cursor: pointer;
      font: inherit;
      margin-top: 20px;
      padding: 10px 18px;
    }

    button:focus-visible {
      outline: 3px solid #4d4f53;
      outline-offset: 3px;
    }
  }

  .toolbar {
    position: absolute;
    top: 40px;
    left: 0;
    right: 0;
    height: 70px;

    .top {
      width: 500px;
      margin: 0 auto;
      height: 32px;
      display: flex;

      > a, > button {
        background: transparent;
        border: 0;
        color: #7f7f7f;
        flex: 1;
        font-size: 32px;
        padding: 0;
        text-align: center;
      }

      > a:hover,
      > button:hover {
        color: #4d4f53;
      }

      > .facebook-icon:hover {
        color: #4267B2;
      }

      > .twitter-icon:hover {
        color: #1DA1F2;
      }

      > .close-icon:hover {
        color: #fd5c63;
      }

      > a.disabled {
        color: #ccc;
        pointer-events: none;
      }

      @media (prefers-reduced-motion: no-preference) {
        a.next-button, a.prev-button {
          transition: transform .15s ease-in-out;
        }
      }

      a.next-button.move {
        transform: translateX(250px);
      }

      a.prev-button.move {
        transform: translateX(-250px);
      }
    }

    button {
      display: inline-block;
      cursor: pointer;
    }
  }

  .magazine {
    width: 960px;
    height: 700px;

    :global(.shadow) {
      position: absolute;
      top: 0;
      left: 0;
      overflow: hidden;
      width: 1000px;
      height: 700px;
      box-shadow: 0 0 20px #ccc;
    }

    &.move-left {
      transform: translateX(-250px) !important;
      box-shadow: none;

      :global(.shadow) {
        box-shadow: none;
      }

      &.last-page {
        transform: translateX(250px) !important;
      }
    }

    :global(.page) {
      position: absolute;
      top: 0;
      left: 0;
      bottom: 0;
      right: 0;
      width: 500px;
      height: 700px;
      background:white;
      box-shadow: 0 0 5px rgba(0,0,0,0.2);
    }

    :global(.page-media-state) {
      align-items: center;
      background: white;
      display: flex;
      flex-direction: column;
      inset: 0;
      justify-content: center;
      pointer-events: none;
      position: absolute;
      z-index: 10;
    }

    :global(.page-media-state .loader) {
      flex: 0 0 80px;
      left: auto;
      position: relative;
      top: auto;
    }

    :global(.page-media-state p) {
      color: #4d4f53;
      font-size: 18px;
      margin: 20px 30px 0;
      text-align: center;
    }

    :global(.page-media-state button) {
      background: #698145;
      border: 0;
      border-radius: 3px;
      color: white;
      cursor: pointer;
      font: inherit;
      margin-top: 20px;
      padding: 10px 18px;
      pointer-events: auto;
    }

    :global(.page-media-state button:focus-visible) {
      outline: 3px solid #4d4f53;
      outline-offset: 3px;
    }

    :global(.odd .gradient) {
      position:absolute;
      top:0;
      left:0;
      width:100%;
      height:100%;
      z-index:0;
      background:-webkit-gradient(linear, right top, left top, color-stop(0.95, rgba(0,0,0,0)), color-stop(1, rgba(0,0,0,0.15)));
      background-image: linear-gradient(to left, rgba(0,0,0,0) 95%, rgba(0,0,0,0.15) 100%);
    }

    :global(.even .gradient) {
      position:absolute;
      top:0;
      left:0;
      width:100%;
      height:100%;
      z-index:0;
      background:-webkit-gradient(linear, left top, right top, color-stop(0.95, rgba(0,0,0,0)), color-stop(1, rgba(0,0,0,0.2)));
      background-image:linear-gradient(to right, rgba(0,0,0,0) 95%, rgba(0,0,0,0.2) 100%);
    }

    :global(.zoom-in .gradient) {
      display: none;
    }

    :global(.zoom-in .next-button),
    :global(.zoom-in .previous-button) {
      display: none;
    }
  }
</style>

<div
  in:fly={{ duration: 300, y: -90, delay: 550 }}
  out:fly={{ duration: 300, y: -90 }}
  class="toolbar">
  <div class="top">
    <a
      class="prev-button"
      class:disabled={previousNavigationDisabled}
      class:move={!moveLeft}
      onclick={(event) => handleReaderNavigation(
        event,
        prevPage,
        previousNavigationDisabled,
      )}
      href="/dergiler/sayi{index}/{prevPage}"
      aria-disabled={previousNavigationDisabled ? 'true' : undefined}
      aria-label="Önceki Sayfa"
      tabindex={previousNavigationDisabled ? -1 : undefined}
      title="Önceki Sayfa">
      <Icon name="arrow-alt-circle-left" />
    </a>

    <a
      class:disabled={!readerReady}
      href="/dergiler/sayi{index}/{tableOfContents}"
      aria-disabled={!readerReady ? 'true' : undefined}
      aria-label="İçindekiler"
      tabindex={!readerReady ? -1 : undefined}
      title="İçindekiler"
      onclick={(event) => handleReaderNavigation(event, tableOfContents, !readerReady)}>
      <Icon name="list-alt" />
    </a>

    <button
      type="button"
      onclick={shareOnFacebook}
      aria-label="Facebook'ta Paylaş"
      title="Facebook'ta Paylaş"
      class="facebook-icon"
    >
      <Icon name="facebook-f" />
    </button>

    <button
      type="button"
      onclick={shareOnTwitter}
      aria-label="Twitter'ta Paylaş"
      title="Twitter'ta Paylaş"
      class="twitter-icon"
    >
      <Icon name="twitter" />
    </button>

    <button
      type="button"
      onclick={close}
      aria-label="Kapat"
      title="Kapat"
      class="close-icon"
    >
      <Icon name="times-circle" />
    </button>

    <a
      class="next-button"
      class:disabled={nextNavigationDisabled}
      class:move={!moveLeft}
      onclick={(event) => handleReaderNavigation(
        event,
        nextPage,
        nextNavigationDisabled,
      )}
      href="/dergiler/sayi{index}/{nextPage}"
      aria-disabled={nextNavigationDisabled ? 'true' : undefined}
      aria-label="Sonraki Sayfa"
      tabindex={nextNavigationDisabled ? -1 : undefined}
      title="Sonraki Sayfa">
      <Icon name="arrow-alt-circle-right" />
    </a>
  </div>
</div>

<div
  class="container"
  in:fly={{ duration: 1000, y: -750 }}
  out:fly={{ duration: 1000, y: -750 }}
  onoutroend={onOutroEnd}>
  <div class="center">
    {#if readerLoadState !== READER_LOAD_STATE.READY}
      <div
        class="reader-load-page"
        class:move-left={moveLeft}
        aria-busy={readerLoadState === READER_LOAD_STATE.LOADING}>
        {#if readerLoadState === READER_LOAD_STATE.LOADING}
          <div class="loader" aria-hidden="true">
            <div></div><div></div><div></div><div></div>
          </div>
          <p role="status" aria-live="polite">Sayı {index} yükleniyor…</p>
        {:else}
          <p role="alert">Dergi yüklenemedi.</p>
          <button type="button" onclick={() => void loadReader()}>Tekrar dene</button>
        {/if}
      </div>
    {/if}
    <div
      bind:this={magazine}
      class:move-left={moveLeft}
      class:last-page={currentPage === numberOfPages}
      class="magazine">
      {#each initialRenderedPageNumbers as page (page)}
        <div
          class="page"
          class:even={page % 2 === 0}
          class:odd={page % 2 !== 0}
          id="page-{page}"
          data-page-number={page}>
          {@html renderPageContent(page, initialPages[page])}
          {#if pageContainsMedia(initialPages[page])}
            <div class="page-media-state" data-page-media-state>
              <div class="loader" aria-hidden="true">
                <div></div><div></div><div></div><div></div>
              </div>
              <p>Sayfa {page} yükleniyor…</p>
              <button type="button" hidden>Tekrar dene</button>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>
