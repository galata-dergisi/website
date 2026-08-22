# Full-stack local development

`npm run dev` is the only development runtime command. It builds the browser and
SSR bundles, generates a development-only site, validates the local media
catalog, builds the Go development server, and then watches the complete
application.

## Toolchain

The command requires the exact Node and Go versions in `.nvmrc` and
`.go-version`. The npm version is declared by `packageManager`, and
`package-lock.json` pins the complete dependency graph. Development exits
before building anything when either runtime version differs.

```sh
nvm install
nvm use
npm ci
```

## Browser compatibility

Internet Explorer is completely outside this project's support scope, including
IE 11 and every earlier version. Do not add polyfills, transpilation, CSS
fallbacks, tests, or implementation compromises solely for Internet Explorer.
Browser compatibility work should instead focus on the project's maintained
Chrome, Edge, Firefox, desktop Safari, and iOS Safari targets.

The production build remains `npm run build`; it still generates
`internal/site/dist/` for embedding in the production Go binary. Development
uses the programmatic Vite builder to emit unminified, source-mapped IIFE
bundles and the CommonJS Svelte SSR adapter; production emits minified IIFEs
with the same `public/bundle.js`, `public/bundle.css`, and
`build/ssr/HomePage.cjs` paths. Development generations are isolated in
versioned directories below `build/dev-sites/`.
Production builds and `npm run dev` regenerate the ignored, low-resolution
homepage carousel sheet from `client/images/sayi*/thumbnail.jpg`. Development
also regenerates it when a source thumbnail or its sheet configuration changes.
Run `npm run generate:carousel-sheet` to refresh the asset directly.

## Environment files

Create a mode-specific local file from the shared example when you need to
change runtime settings:

```sh
cp .env.example .env.development
```

`npm run dev` loads `.env.development` once at startup when it exists. An inherited
shell value overrides the file, and `--port` or `--media-root` overrides both.
Restart development after editing the file.

Development reads the port from `LISTEN_ADDR`, which must use
`127.0.0.1:<port>`. `EXTERNAL_MEDIA_DIR` selects the local media tree. Relative
paths are resolved from the repository root. Other values are passed to child
processes.

Direct local development does not add CSP response headers. Its refresh client
is nevertheless served as the stable same-origin `/__dev/runtime.js` asset and
reads the current generation token from non-executable JSON. The deployed
`dev.galatadergisi.org` nginx vhost owns its independently staged CSP header.

The same `.env.example` is the starting point for `.env.production`. Remove or
edit values that do not apply to the selected mode. Both local mode files are
ignored by Git, and none of the env files enter Docker build contexts.

## Local production preview

Use the Docker production preview when you need the production browser build,
embedded Go server, and nginx boundary instead of watched development behavior:

```sh
npm run preview:production
```

When `.env.production` exists, the preview commands pass it to Docker Compose.
Shell values still win. The file is runtime configuration only: it is not
available to the Node site build or any Docker image build stage.

The command builds an immutable image from the current checkout and serves it
at `https://localhost:44443`. The Go application listens only on the containers'
shared loopback interface; only nginx's TLS port is published, and it is bound
to host loopback. Source files are not mounted into either container, so rerun
the command with `--build` (as the package command does) after every source or
catalog change.

The nginx image starts from `ops/nginx/galatadergisi.org.conf`. It changes only
the accepted server name to `localhost`, supplies a local TLS include, and uses
a generated self-signed certificate for `localhost` and `127.0.0.1`. A browser
will show a certificate warning; accept it only for this local endpoint. The
site otherwise retains production canonical URLs, cache behavior, service
worker registration, analytics, and security headers. Local visits can
therefore send events to the production analytics service.

The preview inherits the production access-log disable. Nginx errors go only
to container stderr and are removed with the preview container; it does not
create the persistent VPS error-log files or use their logrotate policy.

The preview mounts the sibling production media checkout read-only at nginx's
production media path. Use an absolute alternate path or port when needed:

```sh
GALATA_MEDIA_ROOT=/absolute/path/to/server-assets/public \
  GALATA_PREVIEW_HTTPS_PORT=45443 \
  npm run preview:production
```

Follow application output and nginx error output, or stop the preview with:

```sh
docker compose -f ops/local-production/compose.yaml logs --follow
npm run preview:production:down
```

To build a separate preview stack and verify HTTPS, production rendering,
caching, media, and the retired submission route, run:

```sh
npm run test:production-preview
```

The smoke command uses port `44444` and its own temporary Compose project, then
removes only those isolated resources.

## Local media

Development has no production or network fallback for magazine media. The
default media root is the sibling static-assets checkout:

```text
../galata-dergisi-static-assets/server-assets/public
```

Its complete local media set has this layout:

```text
server-assets/public/
├── images/
│   └── sayiN/
│       ├── thumbnail.jpg
│       └── … page and published media files
└── audio/
    └── sayiN/
        └── … mp3 and ogg recitations
```

Before binding a port, the orchestrator reads `content/public.sqlite` and
checks every magazine thumbnail, page image, published-media path, and
canonical MP3/OGG recitation path. All missing and invalid paths are reported
together. Add or restore every listed file and run `npm run dev` again.

Use another complete media tree with `--media-root`:

```sh
npm run dev -- --media-root /absolute/path/to/galata-media
```

Requests below `/images/` map to `<media-root>/images/`.
`/magazines/sayiN/audio/file` maps to
`<media-root>/audio/sayiN/file`. Only regular files are served; directory
listing and path traversal are rejected. `GET`, `HEAD`, and byte ranges are
supported.

## Running

```sh
npm run dev
npm run dev -- --port 3100
npm run dev -- --port 3100 --media-root public
```

The defaults are:

- URL: `http://127.0.0.1:3000`
- media root:
  `../galata-dergisi-static-assets/server-assets/public`

The server binds only to loopback and prints its URL without opening a browser.
Vite LiveReload also binds only to loopback, on port `35729`; stop the process
already using that port if the watcher reports `EADDRINUSE`. `--port` changes
the application server port, not the LiveReload port.
Development pages are marked `noindex`; analytics and service worker
registration are omitted. The page also unregisters an earlier localhost
service worker and removes `galatadergisi-` browser caches.

## Rebuild and recovery behavior

| Change | Development action |
| --- | --- |
| Browser Svelte, JavaScript, CSS, or copied frontend asset | Vite rebuilds with source maps and LiveReload refreshes the browser |
| SSR output, HTML template, generator, catalog, or generator library | A new versioned site is generated and the server restarts with a new generation token |
| Go command or internal package | Only the development binary is rebuilt, then the server restarts |
| Catalog media file | The complete media inventory is revalidated |

Changes are coalesced and rebuilds run serially. A frontend compilation error
is retained by Vite for correction. A generator, media, or Go build error
does not stop the last healthy server. Fix the file and save again; the next
change retries the affected work and installs the new generation only after
all checks pass.

`SIGINT` and `SIGTERM` close all watchers and stop both Vite and the Go child
process. If the browser appears to show an old production page, reload once
after starting development; the injected cleanup removes the old service
worker and caches.
