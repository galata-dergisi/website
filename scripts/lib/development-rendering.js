// Copyright 2026 Mehmet Baker
//
// Development-only HTML changes. Production generation never calls this
// module's transform, keeping release documents byte-for-byte unchanged.

function developmentClient(generationToken) {
  const generation = JSON.stringify(generationToken).replace(/</g, '\\u003c');
  return `<script>
      (function galataDevelopmentRuntime() {
        var expectedGeneration = ${generation};
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
    </script>`;
}

function renderDevelopmentDocument(source, generationToken) {
  let html = String(source);
  html = html
    .replace(
      /<script>\s*if\s*\(\s*['"]serviceWorker['"]\s+in\s+navigator\s*\)[\s\S]*?<\/script>/gi,
      '',
    )
    .replace(
      /<script[^>]+src=["']https:\/\/www\.googletagmanager\.com\/[^"']+["'][^>]*><\/script>/gi,
      '',
    )
    .replace(
      /<script>\s*window\.dataLayer\s*=[\s\S]*?gtag\(\s*['"]config['"][\s\S]*?<\/script>/gi,
      '',
    );
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
  developmentClient,
  renderDevelopmentDocument,
};
