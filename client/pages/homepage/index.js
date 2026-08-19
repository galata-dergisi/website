// Copyright 2020 Mehmet Baker
//
// This file is part of galata-dergisi.
//
// galata-dergisi is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// galata-dergisi is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with galata-dergisi. If not, see <https://www.gnu.org/licenses/>.

import { hydrate, mount } from 'svelte';
import HomePage from './HomePage.svelte';
import {
  READER_CACHE_WARM_GRACE_MS,
  shouldWarmReaderCache,
} from '../../lib/reader-cache-policy.mjs';

function registerServiceWorkerAfterLoad() {
  if (!('serviceWorker' in navigator) || window.galataDevelopment) return;

  const register = async () => {
    try {
      await navigator.serviceWorker.register('/service-worker.js');
      const registration = await navigator.serviceWorker.ready;
      const warm = () => {
        const connection = navigator.connection
          || navigator.mozConnection
          || navigator.webkitConnection
          || null;
        if (!shouldWarmReaderCache({
          online: navigator.onLine,
          connection,
        })) return;
        const worker = registration.active || navigator.serviceWorker.controller;
        if (worker) worker.postMessage({ type: 'WARM_READER_CACHE' });
      };
      window.setTimeout(() => {
        if ('requestIdleCallback' in window) {
          window.requestIdleCallback(warm, { timeout: 10_000 });
        } else {
          warm();
        }
      }, READER_CACHE_WARM_GRACE_MS);
    } catch (error) {
      console.warn('Service worker registration failed.', error);
    }
  };

  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
}

const target = document.getElementById('app');
const bootstrapElement = document.getElementById('galata-bootstrap');
let bootstrap = {};

try {
  bootstrap = JSON.parse(bootstrapElement ? bootstrapElement.textContent : '{}');
} catch (error) {
  console.trace(error);
}

if (!bootstrap.hydratable) {
  target.innerHTML = '';
}

registerServiceWorkerAfterLoad();

const start = bootstrap.hydratable === true ? hydrate : mount;
const homePage = start(HomePage, {
  target,
  props: {
    initialMagazines: bootstrap.initialMagazines || [],
    initialMagazineIndex: bootstrap.initialMagazineIndex || null,
    initialPages: bootstrap.initialPages || null,
    initialAudioPlayers: bootstrap.initialAudioPlayers || null,
    initialLandingPage: bootstrap.initialLandingPage || 1,
    initialWorkStartPage: bootstrap.initialWorkStartPage || null,
    initialWorkEndPage: bootstrap.initialWorkEndPage || null,
    initialArtwork: bootstrap.initialArtwork || {},
    initialHash: window.location.hash,
  },
});

export default homePage;
