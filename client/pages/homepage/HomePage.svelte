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

  import { fly } from 'svelte/transition';
  import { onMount, tick } from 'svelte';
  import '../../styles/layout.scss';
  import Utils from '../../lib/Utils.js';
  import { shouldHandleDirectionalNavigation } from '../../lib/link-navigation.mjs';
  import { createReaderTransitionCoordinator } from '../../lib/reader-transition.mjs';
  import { HOME_FALLBACK_TITLE } from '../../lib/seo-head.mjs';
  import IconSprite from './components/IconSprite.svelte';
  import Footer from './components/Footer.svelte';
  import Carousel from './components/Carousel.svelte';
  import Magazine from './components/Magazine.svelte';
  import MagazineThumbnail from './components/MagazineThumbnail.svelte';
  import {
    homeHistoryState,
    isHomeHistoryState,
    issueHistoryState,
    READER_HISTORY_ACTION,
    updateReaderHistory,
  } from '../../lib/reader-history.mjs';
  /**
   * @typedef {Object} Props
   * @property {any} [initialMagazines]
   * @property {any} [initialMagazineIndex]
   * @property {any} [initialPages]
   * @property {any} [initialAudioPlayers]
   * @property {number} [initialLandingPage]
   * @property {any} [initialWorkStartPage]
   * @property {any} [initialWorkEndPage]
   * @property {string} [initialHash]
   * @property {any} [initialArtwork]
   */

  /** @type {Props} */
  let {
    initialMagazines = [],
    initialMagazineIndex = null,
    initialPages = null,
    initialAudioPlayers = null,
    initialLandingPage = 1,
    initialWorkStartPage = null,
    initialWorkEndPage = null,
    initialHash = '',
    initialArtwork = {},
  } = $props();

  function createInitialState() {
    const all = initialMagazines.slice();
    const sorted = initialMagazines.slice().sort((a, b) => b.index - a.index);
    return {
      all,
      sorted,
      landingPage: initialLandingPage,
      landingHash: initialHash,
      loadedMagazine: initialMagazineIndex === null
        ? null
        : all.find((magazine) => magazine.index === initialMagazineIndex),
      historyAction: initialMagazineIndex === null
        ? READER_HISTORY_ACTION.NONE
        : READER_HISTORY_ACTION.REPLACE,
    };
  }

  const initialState = createInitialState();
  const allMagazines = initialState.all;
  let latestMagazine = $state.raw(initialState.sorted[0] || null);
  let carouselMagazines = $state.raw(initialState.sorted.slice(1));

  let landingPage = $state(initialState.landingPage);
  let landingHash = $state(initialState.landingHash);
  let loadedMagazine = $state.raw(initialState.loadedMagazine);
  let loadedMagazineSvelteInstance = $state(null);
  let landingHistoryAction = $state(initialState.historyAction);
  let landingReturnToHome = $state(false);
  let homepageContainer = $state(null);
  const readerTransition = createReaderTransitionCoordinator();
  let magazineReturnFocusElement = null;

  async function getMagazines() {
    try {
      // List of magazines
      const result = await Utils.httpGet('/magazines', { json: true });

      if (!result.success) throw new Error(`Couldn't get the magazines.`);

      allMagazines.push(...result.magazines);

      // Sort magazines by index and determine the latest one (descending sort)
      result.magazines.sort((a, b) => b.index - a.index);
      latestMagazine = result.magazines[0];

      // Rest of the magazines will be presented in the carousel slider
      carouselMagazines = result.magazines.slice(1);
    } catch (ex) {
      console.trace(ex);
      alert('Beklenmedik bir hata oluştu. Lütfen sayfayı yenileyerek tekrar deneyiniz.');
    }
  }

  function unloadMagazine({ restoreFocus = true } = {}) {
    if (!loadedMagazineSvelteInstance && !readerTransition.hasPendingOutro()) {
      loadedMagazine = null;
      return Promise.resolve();
    }

    return readerTransition.beginOutro(() => {
      loadedMagazineSvelteInstance.cancelPendingRequests();
      loadedMagazineSvelteInstance.disposeAudio();
      loadedMagazine = null;
    }, { restoreFocus });
  }

  function requestMagazineUnload(options) {
    readerTransition.invalidateNavigation();
    return unloadMagazine(options);
  }

  async function onMagazineOutroEnd() {
    loadedMagazineSvelteInstance = null;
    const { restoreFocus: shouldRestoreFocus } = readerTransition.finishOutro();

    if (shouldRestoreFocus) {
      const returnFocusElement = magazineReturnFocusElement;
      magazineReturnFocusElement = null;
      await tick();
      if (!loadedMagazine && returnFocusElement?.isConnected) {
        returnFocusElement.focus({ preventScroll: true });
      }
    }
  }

  function onLoadMagazine({ index, page = 1, hash = '' }) {
    const sameIssue = loadedMagazine && loadedMagazine.index === index;
    void loadMagazine(index, page, hash, {
      historyAction: sameIssue
        ? READER_HISTORY_ACTION.REPLACE
        : READER_HISTORY_ACTION.PUSH,
      returnToHome: isHomeHistoryState(window.history.state),
    });
  }

  async function loadMagazine(index, page = 1, hash = '', options = {}) {
    const navigationSequence = readerTransition.beginNavigation();
    const historyAction = options.historyAction || READER_HISTORY_ACTION.PUSH;
    if (loadedMagazine && loadedMagazine.index === index && loadedMagazineSvelteInstance) {
      return loadedMagazineSvelteInstance.goToPage(page, hash, historyAction);
    }

    await unloadMagazine({ restoreFocus: false });
    if (!readerTransition.isCurrentNavigation(navigationSequence)) return false;

    landingPage = page;
    landingHash = hash;
    landingHistoryAction = historyAction;
    landingReturnToHome = Boolean(options.returnToHome);
    const focusedHomepageElement = homepageContainer?.contains(document.activeElement)
      && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (focusedHomepageElement) magazineReturnFocusElement = focusedHomepageElement;
    focusedHomepageElement?.blur();
    loadedMagazine = allMagazines.find((magazine) => magazine.index === index);
    if (focusedHomepageElement) {
      await tick();
      if (!readerTransition.isCurrentNavigation(navigationSequence)) return false;
      document.querySelector('.toolbar .close-icon')?.focus({ preventScroll: true });
    }
    return Boolean(loadedMagazine);
  }

  function loadMagazineFromWindowLocation() {
    // Check if the URL is targeting a magazine
    const res = Utils.getMagazineIndexAndPageFromURL(location.href);

    if (res) {
      void loadMagazine(res.index, res.page, location.hash, {
        historyAction: READER_HISTORY_ACTION.NONE,
        returnToHome: Boolean(window.history.state && window.history.state.returnToHome),
      });
    } else if (location.pathname === '/') {
      if (loadedMagazineSvelteInstance) {
        loadedMagazineSvelteInstance.goToHomepage(READER_HISTORY_ACTION.NONE);
      } else if (loadedMagazine || readerTransition.hasPendingOutro()) {
        readerTransition.invalidateNavigation();
        loadedMagazine = null;
        document.title = HOME_FALLBACK_TITLE;
      }
    }
  }

  function onKeyDown(e) {
    if (!shouldHandleDirectionalNavigation(e)) return;
    if (e.target && e.target.closest
      && e.target.closest('.player_container input, .player_container button')) {
      return;
    }
    switch (e.key) {
      case 'ArrowLeft': {
        if (loadedMagazineSvelteInstance) {
          loadedMagazineSvelteInstance.goToPreviousPage();
        }

        break;
      }

      case 'ArrowRight': {
        if (loadedMagazineSvelteInstance) {
          loadedMagazineSvelteInstance.goToNextPage();
        }

        break;
      }

      default:
        break;
    }
  }

  onMount(() => {
    if (loadedMagazine) {
      updateReaderHistory(
        window.history,
        READER_HISTORY_ACTION.REPLACE,
        issueHistoryState(loadedMagazine.index, landingPage, {
          previousState: window.history.state,
          returnToHome: false,
        }),
        document.title,
        `${window.location.pathname}${window.location.search}${window.location.hash}`,
      );
    } else if (window.location.pathname === '/') {
      updateReaderHistory(
        window.history,
        READER_HISTORY_ACTION.REPLACE,
        homeHistoryState(),
        document.title,
        `${window.location.pathname}${window.location.search}${window.location.hash}`,
      );
    }

    async function initialize() {
      if (allMagazines.length === 0) {
        await getMagazines();
      }

      if (!loadedMagazine) {
        loadMagazineFromWindowLocation();
      }
    }

    initialize();
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('popstate', loadMagazineFromWindowLocation);

    window.gotoMagazinePage = function gotoMagazinePage(magazineIndex, page) {
      const index = Number(magazineIndex);
      const sameIssue = loadedMagazine && loadedMagazine.index === index;
      void loadMagazine(index, Number(page), '', {
        historyAction: sameIssue
          ? READER_HISTORY_ACTION.REPLACE
          : READER_HISTORY_ACTION.PUSH,
        returnToHome: isHomeHistoryState(window.history.state),
      });
    };

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('popstate', loadMagazineFromWindowLocation);
      delete window.gotoMagazinePage;
    };
  });
</script>

<style>
  .container {
    width: 100%;
    height: 100%;
    transition: opacity 1s ease;
    opacity: 1;
  }

  .container.hidden {
    opacity: 0;
    pointer-events: none;
  }

  .row {
    height: 210px;
    isolation: isolate;
    width: 426px;
    margin: 70px auto 0 auto;
    padding-top: 15px;
    position: relative;
  }

  .row::before {
    background-position: bottom;
    background-repeat: no-repeat;
    background-size: 100%;
    content: '';
    filter: drop-shadow(3px 16px 9px rgba(0, 0, 0, .34));
    inset: 0;
    pointer-events: none;
    position: absolute;
    z-index: -1;
  }

  .row-1::before {
    background-image: image-set(
      var(--first-shelf-avif) type("image/avif"),
      var(--first-shelf-fallback) type("image/png")
    );
  }

  .row-2::before {
    background-image: image-set(
      var(--wall-bookshelf-avif) type("image/avif"),
      var(--wall-bookshelf-fallback) type("image/png")
    );
  }

  main {
    width: 100%;
    height: 850px;
    overflow: hidden;
    position: relative;
    box-sizing: border-box;
    background: rgba(255, 255, 255, 1);
    background: -moz-linear-gradient(
      top,
      rgba(255, 255, 255, 1) 0%,
      rgba(254, 254, 254, 1) 50%,
      rgba(242, 242, 242, 1) 71%,
      rgba(217, 217, 217, 1) 100%
    );
    background: -webkit-gradient(
      left top,
      left bottom,
      color-stop(0%, rgba(255, 255, 255, 1)),
      color-stop(50%, rgba(254, 254, 254, 1)),
      color-stop(71%, rgba(242, 242, 242, 1)),
      color-stop(100%, rgba(217, 217, 217, 1))
    );
    background: -webkit-linear-gradient(
      top,
      rgba(255, 255, 255, 1) 0%,
      rgba(254, 254, 254, 1) 50%,
      rgba(242, 242, 242, 1) 71%,
      rgba(217, 217, 217, 1) 100%
    );
    background: -o-linear-gradient(
      top,
      rgba(255, 255, 255, 1) 0%,
      rgba(254, 254, 254, 1) 50%,
      rgba(242, 242, 242, 1) 71%,
      rgba(217, 217, 217, 1) 100%
    );
    background: -ms-linear-gradient(
      top,
      rgba(255, 255, 255, 1) 0%,
      rgba(254, 254, 254, 1) 50%,
      rgba(242, 242, 242, 1) 71%,
      rgba(217, 217, 217, 1) 100%
    );
    background: linear-gradient(
      to bottom,
      rgba(255, 255, 255, 1) 0%,
      rgba(254, 254, 254, 1) 50%,
      rgba(242, 242, 242, 1) 71%,
      rgba(217, 217, 217, 1) 100%
    );
  }

  .logo {
    width: 567px;
    height: 220px;
    margin: 0 auto;
    overflow: hidden;
  }

  .logo img {
    display: block;
    height: 200px;
    max-width: none;
    transform: translateX(-13px);
    width: 567px;
  }
</style>

{#if loadedMagazine}
  <IconSprite />
{/if}

<main>
  {#if !loadedMagazine}
    <div
      class="logo"
      out:fly={{ duration: 1000, y: -220 }}
      in:fly={{ duration: 1000, y: -220, delay: 200 }}>
      <picture>
        {#if initialArtwork.headerLogo?.avif}
          <source srcset={initialArtwork.headerLogo.avif} type="image/avif" />
        {/if}
        <img
          src={initialArtwork.headerLogo?.fallback || '/images/header-logo.jpg'}
          alt="Galata Dergisi"
          width="567"
          height="200"
          decoding="async"
          loading="eager"
          fetchpriority="high" />
      </picture>
    </div>
  {/if}

  <div
    bind:this={homepageContainer}
    class="container"
    class:hidden={loadedMagazine}
    inert={loadedMagazine ? true : undefined}>
    <div
      class="row row-1"
      style:--first-shelf-avif={'url("' + (initialArtwork.firstShelf?.avif || '/images/first-shelf.png') + '")'}
      style:--first-shelf-fallback={'url("' + (initialArtwork.firstShelf?.fallback || '/images/first-shelf.png') + '")'}>
      {#if latestMagazine}
        <MagazineThumbnail
          {onLoadMagazine}
          {...latestMagazine} />
      {/if}
    </div>
    <div
      class="row row-2"
      style:--wall-bookshelf-avif={'url("' + (initialArtwork.wallBookshelf?.avif || '/images/wall-bookshelf.png') + '")'}
      style:--wall-bookshelf-fallback={'url("' + (initialArtwork.wallBookshelf?.fallback || '/images/wall-bookshelf.png') + '")'}>
      <Carousel
        {onLoadMagazine}
        items={carouselMagazines} />
    </div>
  </div>
</main>

<Footer />

{#if loadedMagazine}
  <Magazine
    {...loadedMagazine}
    {landingPage}
    {landingHash}
    initialHistoryAction={landingHistoryAction}
    returnToHome={landingReturnToHome}
    initialPages={loadedMagazine.index === initialMagazineIndex ? initialPages : null}
    initialAudioPlayers={loadedMagazine.index === initialMagazineIndex ? initialAudioPlayers : null}
    initialWorkStartPage={loadedMagazine.index === initialMagazineIndex ? initialWorkStartPage : null}
    initialWorkEndPage={loadedMagazine.index === initialMagazineIndex ? initialWorkEndPage : null}
    {onLoadMagazine}
    onUnloadMagazine={requestMagazineUnload}
    onOutroEnd={onMagazineOutroEnd}
    bind:this={loadedMagazineSvelteInstance} />
{/if}
