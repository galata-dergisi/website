// Copyright 2026 Mehmet Baker
//
// Development-only HTML changes. Production generation never calls this
// module's transform, keeping release documents byte-for-byte unchanged.

const {
  HTML_NAMESPACE,
  applyHtmlReplacements,
  assertClosedHtmlElement,
  collectHtmlElements,
} = require('./html-policy.js');

const DEVELOPMENT_RUNTIME_PATH = '/__dev/runtime.js';

// Keep this asset independent of the generation token so the deployed dev
// vhost can authorize it with a stable same-origin CSP source.
const DEVELOPMENT_RUNTIME_SOURCE = `
(function galataDevelopmentRuntime() {
  'use strict';

  var configurationElement = document.getElementById('galata-development-config');
  if (!configurationElement) return;

  var configuration;
  try {
    configuration = JSON.parse(configurationElement.textContent);
  } catch (error) {
    return;
  }

  var expectedGeneration = configuration.generation;
  var observedServer = null;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then(function (registrations) {
        return Promise.all(registrations.map(function (registration) {
          return registration.unregister();
        }));
      })
      .catch(function () {});
  }
  if ('caches' in window) {
    caches.keys()
      .then(function (names) {
        return Promise.all(names
          .filter(function (name) { return name.indexOf('galatadergisi-') === 0; })
          .map(function (name) { return caches.delete(name); }));
      })
      .catch(function () {});
  }
  window.setInterval(function () {
    fetch('/__dev/status', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('development status unavailable');
        return response.json();
      })
      .then(function (status) {
        if (status.generation !== expectedGeneration) {
          window.location.reload();
          return;
        }
        if (observedServer === null) {
          observedServer = status.server;
        } else if (status.server !== observedServer) {
          window.location.reload();
        }
      })
      .catch(function () {});
  }, 750);
}());
`.trimStart();

function jsonForHtml(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => ({
    '<': '\\u003c',
    '>': '\\u003e',
    '&': '\\u0026',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
  }[character]));
}

function developmentClient(generationToken) {
  const configuration = jsonForHtml({ generation: generationToken });
  return `<script id="galata-development-config" type="application/json">${configuration}</script>
    <script src="${DEVELOPMENT_RUNTIME_PATH}" defer></script>`;
}

function isGoogleTagManagerSource(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname === 'www.googletagmanager.com';
  } catch (_error) {
    return false;
  }
}

function removableDevelopmentScript(source, element) {
  if (element.attributes.has('src')) {
    return isGoogleTagManagerSource(element.attributes.get('src'));
  }
  if (element.attributes.size > 0) return false;

  const end = element.hasExplicitEndTag ? element.contentEndOffset : source.length;
  const content = source.slice(element.contentStartOffset, end);
  const registersServiceWorker = (
    /^\s*if\s*\(\s*['"]serviceWorker['"]\s+in\s+navigator\s*\)/i.test(content)
    && /\bnavigator\.serviceWorker\.register\s*\(/.test(content)
  );
  const configuresGoogleTagManager = (
    /^\s*window\.dataLayer\s*=/i.test(content)
    && /\bgtag\s*\(\s*['"]config['"]/.test(content)
  );
  return registersServiceWorker || configuresGoogleTagManager;
}

function renderDevelopmentDocument(source, generationToken) {
  const input = String(source);
  const replacements = [];
  collectHtmlElements(input)
    .filter((element) => (
      element.namespaceURI === HTML_NAMESPACE && element.tagName === 'script'
    ))
    .forEach((element) => {
      if (!removableDevelopmentScript(input, element)) return;
      assertClosedHtmlElement(element, 'Development document');
      replacements.push({
        start: element.startOffset,
        end: element.endOffset,
        content: '',
      });
    });
  let html = applyHtmlReplacements(input, replacements);
  if (!/<meta\s+name=["']robots["']/i.test(html)) {
    html = html.replace(
      /<head>/i,
      '<head>\n    <meta name="robots" content="noindex, nofollow" />',
    );
  }
  return html.replace(
    /<\/head>/i,
    `    ${developmentClient(generationToken)}\n  </head>`,
  );
}

module.exports = {
  DEVELOPMENT_RUNTIME_PATH,
  DEVELOPMENT_RUNTIME_SOURCE,
  developmentClient,
  renderDevelopmentDocument,
};
