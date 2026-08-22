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
  import {
    CAROUSEL_PLACEHOLDER_URL,
    getCarouselPlaceholderPosition,
  } from './carousel-placeholder.mjs';
  import { shouldHandleClientNavigation } from '../../../lib/link-navigation.mjs';
  let {
    index,
    publishDateText,
    thumbnailURL,
    thumbnailSources = { avif: [] },
    visible = true,
    carouselItem = false,
    deferImage = false,
    motion = null,
    onLoadMagazine = () => {},
  } = $props();

  let placeholderPosition = $derived(getCarouselPlaceholderPosition(index));
  let thumbnailStyle = $derived([
    ...(placeholderPosition ? [
      `--placeholder-image: url(${CAROUSEL_PLACEHOLDER_URL})`,
      `--placeholder-x: ${placeholderPosition.x}px`,
      `--placeholder-y: ${placeholderPosition.y}px`,
    ] : []),
  ].join('; '));
  let avifSrcset = $derived(
    (thumbnailSources?.avif || [])
      .map((source) => `${source.src} ${source.width}w`)
      .join(', '),
  );
  let imageEnabled = $state(false);
  let shouldRenderImage = $derived(imageEnabled || !deferImage);

  $effect(() => {
    if (!deferImage) imageEnabled = true;
  });

  function handleClick(event) {
    if (!shouldHandleClientNavigation(event, event.currentTarget)) return;
    event.preventDefault();
    onLoadMagazine({ index });
  }
</script>

<style>
  @keyframes fade-in {
    from {
      opacity: 0;
    }

    to {
      opacity: 1;
    }
  }

  @keyframes fade-out {
    from {
      opacity: 1;
    }

    to {
      opacity: 0;
    }
  }

  a {
    display: block;
    width: 100px;
    height: 140px;
    margin: 0 auto;
    outline: 3px solid transparent;
    outline-offset: 4px;
  }

  a:focus-visible {
    outline-color: #698145;
  }

  a.fade-in {
    animation: fade-in .3s ease;
  }

  a.fade-out {
    animation: fade-out .3s ease forwards;
  }

  a.carousel-item {
    margin-right: 50px;
  }

  a.hidden {
    visibility: hidden;
  }

  div.thumbnail-container {
    background-position: var(--placeholder-x) var(--placeholder-y);
    background-repeat: no-repeat;
    background-size: 1444.444444% 660%;
    width: 100px;
    height: 140px;
    box-shadow: 2px 2px 5px rgba(0,0,0,.6);
    transition: transform .1s;
  }

  div.thumbnail-container.has-placeholder {
    background-image: var(--placeholder-image);
  }

  picture,
  img {
    display: block;
    height: 140px;
    width: 100px;
  }

  div.thumbnail-container:hover {
    transform: scale(1.8);
  }

  @media (forced-colors: active) {
    a:focus-visible {
      outline-color: Highlight;
    }
  }
</style>

<a
  href='/dergiler/sayi{index}'
  class:fade-in={motion === 'in'}
  class:fade-out={motion === 'out'}
  class:hidden={!visible}
  class:carousel-item={carouselItem}
  title="{publishDateText} - Sayı {index}"
  onclick={handleClick}>
  <div
    class="thumbnail-container"
    class:has-placeholder={placeholderPosition}
    style={thumbnailStyle}>
    {#if shouldRenderImage}
      <picture>
        {#if avifSrcset}
          <source srcset={avifSrcset} sizes="100px" type="image/avif" />
        {/if}
        <img
          src={thumbnailURL}
          alt="Sayı {index}, {publishDateText}"
          width="100"
          height="140"
          decoding="async"
          loading={carouselItem ? 'lazy' : 'eager'}
          fetchpriority={carouselItem ? 'auto' : 'high'} />
      </picture>
    {/if}
  </div>
</a>
