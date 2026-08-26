# Dev rollout and main merge checklist

This checklist covers the first deployment of the `dev` branch to
`dev.galatadergisi.org`, acceptance testing, and the decision to merge it into
`main`. It does not authorize a production deployment.

The detailed operational reference remains
[`immutable-site-operations.md`](immutable-site-operations.md). Cloudflare cache
configuration is documented separately in
[`../ops/cloudflare/README.md`](../ops/cloudflare/README.md).

## Readiness snapshot — 2026-08-14

The branch is technically healthy but **not ready to merge yet**.

Verified at assessment time:

- `origin/main` is `ca4b1d6`, matching the local `main` branch.
- Before the preparation commits, local `dev` was `a76487d`, 75 commits ahead
  and 0 commits behind `main`.
- `main` is an ancestor of `dev`, so there is currently no branch conflict.
- There is no remote `dev` branch yet.
- The canonical content check, runtime-boundary check, lint, unit tests, SSR
  tests, service-worker tests, browser page-turn tests, Go tests, Go race tests,
  Go vet, deterministic generation, and npm production audit all pass.
- The isolated ZAP baseline scanned 794 URLs and the active scan covered
  1,064 URLs with 109 passing rules. Both completed with zero FAIL or WARN
  findings; report review found only the classified origin-boundary and
  third-party-resource alerts.
- The full build-time and production-only dependency audits report zero
  vulnerabilities after updating dev-only `nanoid` through PostCSS to 3.3.18.
- The generated site contains 2,306 routes and 4,226 unique files.
- Homepage cold transfer is 105,500 of 110,000 bytes.
- Homepage JavaScript is 49,335 of 50,000 gzip bytes. This leaves only 665
  bytes of headroom; do not raise this separate ceiling without review.
- The server's Phase 2 helper, nginx files, and systemd units exactly match the
  branch. The restricted deployment identity works.
- `cloudflared` is active, nginx listens on loopback port 8080, and the public
  dev health URL redirects to Cloudflare Access.
- The dev slot is empty: no current code/media links exist and
  `galata-dev-server.service` is disabled and inactive.

Outstanding merge gates:

- Push `dev` and obtain a successful pull-request CI run and review.
- Build a clean immutable release and deploy it to the dev slot.
- Complete authenticated, unauthenticated, media, service-worker, rollback, and
  observation-window checks on the deployed release.

## 1. Work from a stable connection

Prefer a trusted network that does not intermittently filter SSH. Keep the
Hetzner KVM console available until the first deployment has passed remote and
public verification.

Confirm both administration and restricted deployment paths:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 \
  -o ControlMaster=no -o ControlPath=none -o ControlPersist=no \
  galata true

ssh -o BatchMode=yes -o ConnectTimeout=10 \
  -o ControlMaster=no -o ControlPath=none -o ControlPersist=no \
  -i "$HOME/.ssh/galata-deploy" -o IdentitiesOnly=yes \
  galata-deploy@galata \
  'sudo -n /usr/local/sbin/galata-deploy-helper status'
```

Do not run `setup-server.sh verify`: that verifier intentionally describes the
pre-Phase-2 state and now rejects the installed nginx sites and HTTP snippet.

## 2. Confirm the prepared candidate

The preparation changes are intentionally split into four semantic commits:

- remove the trailing blank line from the ZAP baseline;
- raise the homepage transfer ceiling to 110,000 bytes;
- add the Cloudflare caching runbook;
- add this dev rollout and merge checklist.

Confirm that history has those separate subjects and that the checkout is
clean:

```sh
git switch dev
git status --short
git log --oneline -4
```

The release builder refuses a dirty checkout. Confirm cleanliness before
continuing:

```sh
test -z "$(git status --porcelain --untracked-files=normal)"
git diff --check origin/main...dev
```

## 3. Push `dev` and open a draft pull request

Publish the exact candidate commit and open a draft pull request so the
`Verify site and server` workflow runs before deployment:

```sh
git push -u origin dev
gh pr create --base main --head dev --draft
```

Record the candidate commit:

```sh
git rev-parse HEAD
```

Do not change the candidate after deploying it. Any code, configuration,
content, dependency, or generated-output change creates a new candidate and
requires the build, deployment, and relevant acceptance checks again.

## 4. Reproduce the complete local gate

Use the repository-pinned Node 24.18.0 and Go 1.27.0 versions. The sibling
static-assets checkout must be clean.

```sh
nvm use
npm ci
git -C ../galata-dergisi-static-assets status --short
export GALATA_STATIC_ASSETS_ROOT=../galata-dergisi-static-assets/server-assets/public/images
```

Run the content, source, and build checks:

```sh
npm run content:verify
npm run verify:runtime-boundary
npm run lint
npm run build
npm run verify:page-turn-size
npm run verify:site
npm test
npm run test:ssr
npm run test:service-worker
npm run test:page-turn
```

Prove that generation is deterministic:

```sh
npm run hash:site > /tmp/galata-site-first.sha256
npm run build
npm run hash:site > /tmp/galata-site-second.sha256
diff -u /tmp/galata-site-first.sha256 /tmp/galata-site-second.sha256
```

Run Go and dependency checks:

```sh
go test ./...
go test -race ./...
go vet ./...
npm run audit
npm audit
```

Start Docker Desktop and run both isolated production-mode security scans:

```sh
npm run security:zap
npm run security:zap:active
```

Review every report under `zap-reports/`, including warnings that do not fail
the baseline command. Do not suppress a finding merely to make the command
green.

Finally, wait for the draft pull request's exact-SHA `Verify site and server` workflow
to succeed. Investigate any difference between CI and the local results.

## 5. Build and bind the immutable release

Confirm both repositories are clean immediately before building:

```sh
test -z "$(git status --porcelain --untracked-files=normal)"
test -z "$(git -C ../galata-dergisi-static-assets status --porcelain --untracked-files=normal)"
```

Build and validate the release:

```sh
npm run build
sh scripts/build-release.sh
cd release
shasum -a 256 -c SHA256SUMS
cd ..
node scripts/scan-release.js \
  release/galata-server-linux-amd64 \
  release/galata-server-linux-arm64
```

Confirm that the manifest is bound to the candidate currently under review:

```sh
candidate_sha=$(git rev-parse HEAD)
manifest_sha=$(sed -n 's/^application_commit=//p' release/RELEASE-MANIFEST)
test "$candidate_sha" = "$manifest_sha"
sed -n '/^release_id=/p;/^static_assets_commit=/p;/^embedded_site_release=/p' \
  release/RELEASE-MANIFEST
```

Save the displayed release ID and both commit IDs in the pull request or
rollout notes.

## 6. Recheck the foundation without reconfiguring it

Phase 2 and the tunnel are already configured. Do not rotate the tunnel token,
and do not rerun `configure` merely because this is the first application
deployment.

```sh
ssh galata 'systemctl is-active cloudflared.service && \
  sudo -n nginx -t && \
  sudo -n ss -H -ltn'

curl --silent --show-error --dump-header - --output /dev/null \
  https://dev.galatadergisi.org/healthz
```

The unauthenticated request must return `302`, `303`, or `307` with an HTTPS
`/cdn-cgi/access/login/` location. Nginx, helper, and service files matched the
branch during this assessment. Rerun `deploy-server.sh configure` only if one
of those tracked files subsequently changes or a hash comparison proves drift;
`configure` now takes no feature-specific secret option.

The URL-specific purge release introduces a new helper capability and pending
plan directory. Run `./ops/deploy-server.sh configure` once from the updated
checkout before its first deployment. This installs the helper change on
`galata`; Cloudflare API credentials remain on the deployment client and are
never copied to the VPS.

## 7. Deploy only the dev slot

From the clean candidate checkout, run the interactive first deployment:

```sh
export CLOUDFLARE_ZONE_ID='<32-character zone id>'
read -r -s CLOUDFLARE_CACHE_PURGE_TOKEN
export CLOUDFLARE_CACHE_PURGE_TOKEN

./ops/deploy-server.sh deploy dev \
  --release-dir release \
  --media-root ../galata-dergisi-static-assets/server-assets/public
```

Read the confirmation carefully. The target must be `dev`, not `production`.
Do not add `--yes` for this first manual deployment.

Immediately run both restricted-origin and public-path verification:

```sh
./ops/deploy-server.sh verify dev --public
```

The output must identify the same release ID recorded from
`RELEASE-MANIFEST`. Public verification proves that unauthenticated traffic is
redirected to Access; it does not test the protected application as an allowed
user.

If activation fails, preserve the output and inspect:

```sh
ssh galata 'sudo -n systemctl status galata-dev-server.service --no-pager'
ssh galata 'sudo -n journalctl -u galata-dev-server.service -n 200 --no-pager'
```

Do not open application ports, disable Access, weaken SSH, or change firewall
defaults as a workaround.

## 8. Complete dev acceptance

Sign in through Cloudflare Access with an allowed identity and check:

1. `/healthz` reports the embedded site release from the manifest.
2. The homepage, early and late issues, continuation pages,
   contributor pages, canonical redirects, and JSON aliases load correctly.
3. Back/forward navigation, direct issue reload, keyboard navigation, focus
   restoration, reader loading/retry states, and responsive layouts work.
4. Audio playback, track switching, seek/buffer display, and image/video media
   work on desktop and mobile-sized viewports.
5. External images load and an audio range request returns partial content.
6. The service worker installs and a reload/update does not strand the browser
   on the previous release.
7. `/katkida-bulunun` returns `404`, and a `POST` to that path is rejected.

Then use a private session with a disallowed identity and confirm the entire
dev hostname remains unavailable through Cloudflare Access.

After uncached acceptance succeeds, the dev-only rules in
[`../ops/cloudflare/README.md`](../ops/cloudflare/README.md) may be applied and
verified. Keep every rule restricted to `dev.galatadergisi.org`; do not add the
apex or `www` hostnames before an approved production cutover. Repeat the Access
denial test after enabling caching. Once caching is enabled, deploy and rollback
automatically purge only changed stable paths from the tracked cache policy.

Exercise rollback while the release is still confined to dev. A rollback needs
two retained dev releases, so deploy a second reviewed candidate or redeploy
only as allowed by the helper's immutable release rules, then test:

```sh
./ops/deploy-server.sh rollback dev
./ops/deploy-server.sh verify dev --public
```

Return dev to the intended candidate and verify it again before beginning the
observation window.

## 9. Observe the first deployment

Use at least a 24-hour observation window for this first deployment unless a
longer period is agreed. During and after the window, check for restart loops,
panics, nginx errors, tunnel instability, unexpected `4xx`/`5xx` responses,
and media failures.

```sh
./ops/deploy-server.sh verify dev --public

ssh galata 'sudo -n systemctl show \
  -p ActiveState -p SubState -p NRestarts \
  galata-dev-server.service cloudflared.service nginx.service'

ssh galata 'sudo -n journalctl \
  -u galata-dev-server.service -u nginx.service -u cloudflared.service \
  --since "24 hours ago" --priority=warning --no-pager'
```

Record the acceptance results, devices/browsers used, deployed release ID,
rollout time, rollback result, and observation-window conclusion on the pull
request.

## 10. Make the merge decision

Merge only when all of these statements are true:

- the worktree and static-assets checkout are clean;
- the pull-request head is the exact commit deployed to dev;
- all local gates, both ZAP scans, and exact-SHA CI are green;
- authenticated and denied-user Access checks pass;
- media, retired-route, service-worker, and rollback checks pass;
- the observation window has no unresolved errors;
- the 110,000-byte transfer ceiling and very small JavaScript size margin have
  been explicitly accepted;
- review of the 75-commit, 732-file change set is complete.

Before merging, update remote state and confirm that `main` has not advanced:

```sh
git fetch origin
git rev-list --left-right --count origin/main...dev
candidate_prefix=$(git rev-parse --short=12 dev)
./ops/deploy-server.sh verify dev | grep "release=$candidate_prefix-"
```

The rev-list result must still begin with `0`. If `main` advanced, integrate it
into `dev`, create a new release, redeploy, and repeat the affected acceptance
checks.

Prefer a repository-approved fast-forward so `main` points to the exact tested
commit. If branch protection requires GitHub to create a merge or squash
commit, that new `main` SHA is a new release candidate: wait for its CI, deploy
that SHA to dev, and repeat verification before any production deployment.

After merge, wait for the `Verify site and server` workflow on the resulting `main` SHA
to pass. Production deployment is a separate decision requiring explicit
approval and the protected `production` GitHub Environment.
