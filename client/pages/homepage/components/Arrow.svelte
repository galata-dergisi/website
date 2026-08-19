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
  import { shouldHandleDirectionalNavigation } from '../../../lib/link-navigation.mjs';

  let {
    direction = 'left',
    disabled = false,
    onClick = () => {},
    onNavigate = () => {},
  } = $props();
  let navigationLabel = $derived(
    direction === 'right'
      ? 'Dergi listesini sağa kaydır'
      : 'Dergi listesini sola kaydır',
  );

  function activate() {
    if (!disabled) onClick();
  }

  function handlePointerDown(event) {
    if (disabled) event.preventDefault();
  }

  function handleKeyDown(event) {
    if (!shouldHandleDirectionalNavigation(event)) return;
    event.preventDefault();
    onNavigate({ direction: event.key === 'ArrowLeft' ? -1 : 1 });
  }
</script>

<style>
  div {
    width: 80px;
    height: 80px;
  }

  div.right {
    transform: rotate(180deg);
  }

  polygon {
    fill: url(#normalGrad);
  }

  button {
    background: transparent;
    border: 0;
    color: inherit;
    display: block;
    font: inherit;
    height: 100%;
    margin: 0;
    padding: 0;
    -webkit-user-select: none;
    user-select: none;
    width: 100%;
  }

  svg {
    display: block;
    height: 100%;
    width: 100%;
  }

  button:enabled polygon:hover {
    cursor: pointer;
    fill: url(#hoverGrad);
  }

  button:focus {
    outline: 2px solid transparent;
    outline-offset: 2px;
  }

  button:focus-visible polygon {
    stroke: rgba(105, 129, 69, 0.6);
    stroke-width: 6px;
    stroke-linejoin: round;
  }

  @media (forced-colors: active) {
    button:focus-visible {
      outline: none;
    }

    button:focus-visible polygon {
      stroke: Highlight;
    }
  }

  div.disabled polygon {
    fill: #d5d5d5;
  }
</style>

<div 
  class:disabled
  class:right={direction === 'right'}
  class:left={direction === 'left'}>
  <button
    type="button"
    title={navigationLabel}
    aria-label={navigationLabel}
    {disabled}
    onpointerdown={handlePointerDown}
    onclick={activate}
    onkeydown={handleKeyDown}>
    <svg viewbox="0 0 200 200" version="1.1" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="normalGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style="stop-color:#aaa;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#797979;stop-opacity:1" />
        </linearGradient>

        <linearGradient id="hoverGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style="stop-color:#aaa;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#515151;stop-opacity:1" />
        </linearGradient>
      </defs>
      <polygon points="200,0 200,200 0,100" />
    </svg>
  </button>
</div>
