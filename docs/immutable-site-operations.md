# Immutable site operations

## Toolchain and verification

Use the versions pinned in `.nvmrc` and `.go-version`. Install the dependency
graph exactly as recorded in `package-lock.json` with the npm version declared
by `packageManager`.

```sh
npm ci
npm run content:verify
npm run verify:runtime-boundary
npm run build
npm run verify:site
npm run test:ssr
npm run test:service-worker
go test ./...
go test -race ./...
go vet ./...
npm run test:deploy-environment
```

The deployment environment test runs the real helper and systemd service units
inside a privileged Ubuntu 26.04 container. It creates the same production and
development environment files as the server, then proves that transient
candidate processes use ports `39000` and `39001` while the activated services
use ports `3000` and `3001`. Docker must be running.

## OWASP ZAP scans

Docker can build and exercise the production Go application without starting
the watched development runtime:

```sh
npm run security:zap
npm run security:zap:active
```

The harness runs the official OWASP ZAP baseline and bounded active scans on an
isolated Docker network and writes HTML, JSON, and Markdown results to the
ignored `zap-reports/` directory. The baseline performs passive analysis only;
the explicit active command sends attack payloads to the containerized target.
Both commands first verify the missing-Turnstile-token and filled-honeypot
rejection contracts without making a third-party request.
See [`ops/zap/README.md`](../ops/zap/README.md) for rule policy, scope, and
timeout overrides.

To prove the complete browser/SSR/site build is deterministic, compare the
sorted file-hash stream from two builds:

```sh
npm run build
npm run hash:site > /tmp/galata-site-first.sha256
npm run build
npm run hash:site > /tmp/galata-site-second.sha256
diff -u /tmp/galata-site-first.sha256 /tmp/galata-site-second.sha256
```

## Bootstrapping an Ubuntu 26.04 host

`ops/setup-server.sh` is the one-time, workstation-driven bootstrap for the
development VPS. It expects the local SSH host `galata` to connect as `root`
on the first run. Before using it, update and upgrade Ubuntu, reboot, attach
the machine to Ubuntu Pro, and confirm that `ssh galata` uses the intended
host key and administrator public key.

Review the target and confirm interactively:

```sh
./ops/setup-server.sh apply
```

For an already reviewed invocation, `--yes` skips only the local confirmation:

```sh
./ops/setup-server.sh apply --yes
```

Both `apply` and `verify` prompt for the administrator username. The name must
use a conservative Linux account format (`[a-z_][a-z0-9_-]*`, at most 32
characters); `root` and the reserved `galata` runtime account are rejected.
Enter the same administrator name on later reruns and verification calls.

The script creates the selected key-only administrator, proves a fresh login
and passwordless sudo work, and performs all remaining setup through that
account. It installs `cloudflared` from Cloudflare's signed stable APT
repository and rejects a package older than `2025.4.0`, which is the minimum
version used by the token-file service. Disabling root SSH is the final remote
mutation. Fresh SSH connections used by the bootstrap disable connection
multiplexing so validation cannot accidentally reuse the original root
transport.

After a successful run, update the local `Host galata` entry from `User root`
to the `User` value printed by the script. The script deliberately does not
edit local SSH configuration. It is safe to rerun before application
deployment: it selects the established administrator path, preserves an
existing non-empty administrator `authorized_keys`, and reconciles only
firewall rules carrying its own comments. It aborts instead of deleting
unexpected UFW rules, nginx sites, or conflicting configuration files.

The resulting host has:

- key-only SSH for members of `sshlogin`, with authentication-failure blocking
  provided by Fail2ban;
- default-deny UFW policy with only SSH admitted; no connection-count limiter
  can lock out successful deployments, and no inbound web or application port
  is exposed;
- Ubuntu/ESM unattended security updates and required reboots at 04:30 in
  `Europe/Istanbul`;
- nginx and `cloudflared` installed, with no enabled virtual host, tunnel
  connector, or web listener;
- a locked `galata` runtime account, private contribution directory, release
  directories, and a hardened but disabled `galata-server.service`;
- when Canonical supports USG on the host release, an initial CIS Level 1
  Server audit and a persistent weekly audit timer. The bootstrap warns and
  skips this audit when USG has not yet been published for a new Ubuntu LTS.

Run the read-only verifier at any time before Phase 2:

```sh
./ops/setup-server.sh verify
```

When USG is available, audit reports are root-owned under `/var/lib/usg/`. A
CIS failure is a report, not permission to run `usg fix`; review and tailor
rules explicitly before any remediation. Rerun `setup-server.sh apply` after
Canonical publishes USG for the host release to install the audit and timer. If
SSH validation fails after provisioning, use the VPS provider's console,
inspect `/etc/ssh/sshd_config.d/00-galata-hardening.conf`, validate with
`sshd -t`, and restore access deliberately. Do not weaken host-key checking or
reopen password/root authentication from an untrusted network.

This bootstrap does not install a release, runtime secret, tunnel token, tunnel
route, or nginx virtual host. Continue with the Phase 2 procedure below. The
Phase 1 verifier intentionally describes the pre-deployment state and should
not be used after Phase 2 enables services and sites.

## Phase 2 deployment foundation

Run the interactive setup from the trusted workstation after Phase 1:

```sh
./ops/deploy-server.sh configure
```

`configure` proves the administrator connection and `sudo -n`, creates a
dedicated Ed25519 key (default `~/.ssh/galata-deploy`), prompts without echoing
for the shared Turnstile secret, and installs the two isolated runtimes. It
refuses to overwrite an existing key pair. A rerun preserves the installed
secret unless `--rotate-turnstile` is explicit. It also writes a verified
`known_hosts` file beside the key: the scan must match host keys read through
the already trusted administrator session. It installs both nginx virtual hosts
on the loopback-only `127.0.0.1:8080` listener and installs the disabled,
hardened `cloudflared.service` unit.

Create one remotely managed tunnel in the Cloudflare dashboard and add these
published application routes:

| Public hostname | Service URL |
| --- | --- |
| `galatadergisi.org` | `http://127.0.0.1:8080` |
| `www.galatadergisi.org` | `http://127.0.0.1:8080` |
| `dev.galatadergisi.org` | `http://127.0.0.1:8080` |

Protect `dev.galatadergisi.org` with a public-hostname Cloudflare Access
application. Leave its path empty so the policy covers the complete site,
including `/healthz`, media, and contribution routes. Add an Allow policy that
includes exact email addresses, an approved identity-provider group, or another
deliberately bounded identity selector. Do not use `Include: Everyone` or use a
login method such as One-time PIN as the only Include selector. Select the
desired identity provider, choose the session duration, and enable **Protect
with Access** on the tunnel's dev published application route so `cloudflared`
also validates the application token. Production and `www` remain public.

Before removing the old origin gate on an existing host, confirm that an
unauthenticated request to `https://dev.galatadergisi.org/healthz` redirects to
an HTTPS `/cdn-cgi/access/login/` URL. The repository intentionally does not
store Access policies or credentials; access is granted and revoked in the
Cloudflare dashboard.

Under **Add a replica**, copy the installation command into a text editor and
extract only its long `eyJ...` connector token. Do not paste the command,
quotes, or angle brackets into the prompt. Then run:

```sh
./ops/deploy-server.sh tunnel-setup
```

`tunnel-setup` prompts without echoing for the tunnel-specific connector token,
stores it as root-only `/etc/cloudflared/tunnel-token` (mode `0600`), enables
the connector, and requires its loopback metrics to report an active Cloudflare
connection. A rerun preserves the installed token; after rotating the token in
the dashboard, pass `--rotate-token`. A failed rotation restores the prior
token and service state. The token is sent to the host over standard input and
never appears in a command line. Neither interactive setup command is suitable
for GitHub Actions.

The restricted `galata-deploy` account is not an administrator. Its SSH key has
OpenSSH `restrict`, it cannot read `/etc/galata`, the tunnel token, or either
contribution inbox, and sudo accepts only the root-owned deployment helper.
Uploads land under `/var/lib/galata-deploy`; the helper alone can install
root-owned releases, change symlinks, or manage services.

| Slot | Host | Service/port | Code link | Contribution state |
| --- | --- | --- | --- | --- |
| production | apex and `www` | `galata-server.service`, `127.0.0.1:3000` | `/opt/galata/current` | `/var/lib/galata-contributions` |
| dev | `dev.galatadergisi.org` | `galata-dev-server.service`, `127.0.0.1:3001` | `/opt/galata/current-dev` | `/var/lib/galata-dev-contributions` |

Both slots may select the same immutable release, but changing one does not
restart or relink the other. Cloudflare Access authenticates dev at the edge,
and dev sends `X-Robots-Tag: noindex, nofollow, noarchive` on every response
while serving a hostname-specific `robots.txt` with `Disallow: /`. UFW exposes
only key-authenticated SSH; Fail2ban blocks repeated authentication failures,
while nginx, connector metrics, and both application ports remain loopback-only.

If both SSH identities fail, recover through the VPS console. Validate the
installed helper and sudoers file, inspect the affected `current` and media
symlinks, and use `journalctl -u` for the service. Do not expose an application
port or weaken SSH to work around a failed deployment.

## Public content

The schema-v2 `content/public.sqlite` is canonical and safe to build only when
`npm run content:verify` succeeds. The verifier requires the exact public schema,
a clean SQLite integrity check, no foreign-key violations, and counts matching
the stored zero-warning catalog summary. It also checks every nominal
publication against historical `Europe/Istanbul` offsets, requires explicit
UTC timestamps, validates all reviewed media facts, and rejects missing or
orphaned media metadata.

Replacing the catalog requires a separately reviewed, complete SQLite file.
Review the replacement outside the repository, then run the full build and
test sequence.

## Building a release

```sh
sh scripts/build-release.sh
cd release
shasum -a 256 -c SHA256SUMS
```

The output contains Linux `amd64` and `arm64` binaries, `RELEASE-MANIFEST`, and
`MEDIA-SHA256SUMS`. Release creation requires clean application and
static-assets checkouts. The manifest binds both commits, the embedded site
release, supported architectures, binary hashes, and the SHA-256 inventory of
the deployed `images/` and `audio/` trees. On the target host,
`uname -m` reports `x86_64` for `amd64` and `aarch64`/`arm64` for `arm64`.
When a protected private-content archive is available during release review,
it can be supplied explicitly to the private-value scanner:

```sh
PRIVATE_CONTENT_ARCHIVE=/protected/path/galata_dergisi.sqlite \
  node scripts/scan-release.js release/galata-server-linux-amd64
```

`scripts/build-release.sh` builds and checksums release artifacts; it does not
install or activate them. Deployment consumes this output and never builds
source on the VPS.

The tunnel client-address mapping, upstreams, and independent rate-limit zones
are in `ops/nginx/galata-shared.conf`; production and dev server blocks are
tracked separately. Phase 2 installs them and validates the complete host with
`nginx -t` before reloading. The tracked configuration sends application routes,
including browser bundles and generated documents, to the immutable Go
server. Nginx serves only the external `/images/sayiN/` media tree and the
public `/magazines/sayiN/audio/file` mapping from
`/var/www/galatadergisi.org/public/`.

The tracked virtual host limits only the exact `POST /katkida-bulunun` route.
It accepts five immediate requests per client, then replenishes at one request
per minute, and permits one in-flight contribution upload per client. Rejected
rate or connection limits are logged at notice level and return HTTP `429`
with `Retry-After: 60` and this JSON contract:

```json
{"ok":false,"code":"submission_throttled","message":"Çok fazla gönderi işleniyor. Lütfen bir dakika sonra tekrar deneyin."}
```

All other methods and routes use an empty limiter key and are excluded from
request and connection accounting. Limiting is active immediately; the
configuration does not use nginx dry-run mode. These are origin controls; no
Cloudflare dashboard rate-limiting rule is required or assumed.

Nginx accepts web traffic only at `127.0.0.1:8080`, and the dashboard-managed
tunnel is the only public route to that listener. Tunneled requests use
`CF-Connecting-IP` as the limiter key; headerless local activation probes fall
back to `$remote_addr`. Dev has no origin `auth_basic` configuration: Cloudflare
Access enforces identity before the request enters the tunnel, and **Protect
with Access** validates its application token at the connector. Local activation
probes remain independent of edge authentication. Never publish another route
to the dev origin or reload until the complete installed configuration passes
`nginx -t`.

The limiter address exists only transiently in nginx's shared-memory zones.
The configuration does not rewrite `$remote_addr`, so access-log identity is
unchanged, and it strips visitor-address headers before proxying to Go. Client
addresses are not sent to Turnstile or written to contribution metadata or
application state.

## Runtime configuration

Create a dedicated contribution location outside the application, reverse
proxy document root, media tree, and backup staging area:

```sh
install -d -m 0700 /var/lib/galata-contributions
```

The process requires:

- `CONTRIBUTIONS_DIR=/var/lib/galata-contributions`
- `TURNSTILE_SECRET_KEY` from protected service configuration
- `TURNSTILE_ALLOWED_HOSTNAMES=galatadergisi.org,www.galatadergisi.org` in
  production, or `dev.galatadergisi.org` in dev
- `EXTERNAL_MEDIA_DIR=/var/www/galatadergisi.org/public`, which makes startup
  reject a contribution root that overlaps the reverse-proxy media tree
- `LISTEN_ADDR=127.0.0.1:3000` when using the tracked nginx configuration

The server optionally loads `.env.production` from its working directory before
validating these values. To keep configuration elsewhere, pass an explicit
path:

```sh
galata-server --env-file /etc/galata/production.env
```

A missing default file is allowed because a service manager may provide the
complete environment. A missing explicitly requested file, malformed file, or
blank required value stops startup. Inherited environment values override the
file. Start from the tracked `.env.example`, replace its safe local paths for
the deployed host, set the real Turnstile secret, and restrict the production
copy to the service account (for example, mode `0600`). Env files are read only
at startup and are never embedded in builds or release artifacts.

`LISTEN_ADDR` defaults to `0.0.0.0:3000`, but the production reverse-proxy
setup must use the explicit loopback address above so the application port is
not exposed directly.

The allowed-hostnames value is mandatory. Empty entries, wildcards, uppercase
or malformed names, and duplicates stop startup. It is deliberately distinct
between slots even though both use the same Turnstile widget and secret.

The server creates `.staging/` and `inbox/` with mode `0700`, removes stale
staging directories older than 24 hours at startup, and writes files with mode
`0600`. Back up the entire contribution root with a tool that preserves modes,
ownership, and directory renames.

Production sets the Go contribution handler's global non-blocking concurrency
cap to eight. Saturation is rejected before the request body is read and uses
the same `429`, `Retry-After`, code, and Turkish message as nginx. Development
leaves the cap at zero (unlimited). The form also posts an empty, hidden
`contactWebsite` honeypot; a filled value creates no inbox data and returns the
existing generic `400 captcha_invalid` response without contacting Turnstile.

## Deploying and rolling back

For a locally built clean release:

```sh
./ops/deploy-server.sh deploy dev \
  --release-dir release \
  --media-root ../galata-dergisi-static-assets/server-assets/public
./ops/deploy-server.sh verify dev --public

./ops/deploy-server.sh deploy production \
  --release-dir release \
  --media-root ../galata-dergisi-static-assets/server-assets/public
```

The script queries the VPS architecture, uploads only its binary, rejects any
manifest/media mismatch or unsafe filesystem object, and performs a conservative
free-space check with a 2 GiB margin. Upload output identifies the application
and media phases with their sizes and reports transfer progress; upstream rsync
clients show aggregate progress, while Apple `openrsync` shows per-file
progress. The helper builds immutable media snapshots with hard links to
unchanged files, runs the candidate on a temporary loopback port under systemd
hardening, atomically switches only the requested slot, and verifies both the
service and nginx route. Any failure restores the previous code/media pair. A
VPS `flock` and the workflow concurrency group serialize activation across both
slots.

For dev, `verify --public` first verifies the active release through the
restricted origin connection, then requires the unauthenticated public
`/healthz` request to redirect to Cloudflare Access. It deliberately does not
impersonate a user or store an Access service token. Complete the authenticated
route and contribution checks in a browser with an allowed identity.

Explicit rollback defaults to the immediately previous retained deployment:

```sh
./ops/deploy-server.sh rollback dev
./ops/deploy-server.sh rollback production <release-id>
```

Five records are retained per slot. Contribution directories are never part of
release activation or rollback.

The manual `Deploy immutable release` GitHub workflow accepts `dev` or
`production` and rejects dispatches outside `main`. It finds the successful
`Verify site and server` run whose `head_sha` exactly equals the selected commit,
then builds, verifies, smoke-tests, and uploads a deployment artifact in its
own run. The deployment job downloads that tested artifact and checks
static-assets out at the commit in its manifest. The `Verify site and server` workflow
does not create or upload release artifacts. Create GitHub Environments named
`dev` and `production`, with required reviewer approval on production.
Configure only:

- `GALATA_DEPLOY_SSH_KEY`
- `GALATA_DEPLOY_HOST`
- `GALATA_DEPLOY_PORT`
- `GALATA_SSH_KNOWN_HOSTS`
- `STATIC_ASSETS_TOKEN` (fine-grained, read-only, and limited to
  `galata-dergisi/static-assets`)

GitHub never receives the Cloudflare Tunnel token, Turnstile secret, Access
identity, or Access session token.

## Dev acceptance and production cutover

After the three dashboard routes are saved, the dev route has **Protect with
Access** enabled, and `tunnel-setup` reports an active connector, deploy and run
`verify dev --public`. Sign in with an allowed identity, then test site routes,
external image/audio range requests, and a complete dev contribution; confirm
that the contribution exists only in the dev inbox. Repeat from a private
browser session with a disallowed identity and confirm that Access denies it.
Keep `galatadergisi.org` authorized on the Turnstile widget; Cloudflare's apex
authorization covers its subdomains, while the server-side environment still
requires the exact dev hostname.

After an independently approved production deployment, run
`verify production --public`, purge relevant Cloudflare cache, and monitor
nginx, `cloudflared`, application health, errors, and contribution creation.
The deployment scripts never create or alter the remotely managed tunnel,
published application routes, or Cloudflare edge TLS configuration.

## Release acceptance

Before selecting a release:

1. Verify its checksum and start it on a temporary localhost-only port with
   production-equivalent configuration.
2. Verify `/healthz`, the homepage, early and late issues, continuation pages,
   contributor canonical redirects, JSON aliases, gzip, `HEAD`, and ETag/304.
3. Verify external image and audio URLs through the reverse proxy, including
   an audio range request.
4. Submit one test contribution, verify its complete directory and hash under
   `inbox/`, and move that directory to the private handled archive.
5. After installing and validating nginx, smoke-test five rapid contribution
   attempts from one client, verify that the sixth returns the documented
   `429` response and header, hold one slow upload open and verify a concurrent
   upload from the same client is rejected, and confirm normal site traffic is
   unaffected.
6. Stop the temporary process. Production deployment is a separate,
   explicitly authorized operation.
