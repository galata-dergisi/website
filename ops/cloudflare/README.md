# Cloudflare caching for the dev-branch rollout

This runbook configures Cloudflare caching for the release built from the
`dev` branch. It does **not** authorize caching the current main-branch
production deployment.

The configuration uses Cache Rules and Cache Response Rules available on the
Cloudflare Free plan. Cache Rules decide which requests are eligible for the
cache; Cache Response Rules inspect the origin status so long TTLs apply only
to successful or revalidated responses.

Cloudflare cannot match a Git branch. It can only match request properties such
as the hostname and path. The branch boundary is therefore enforced by the
activation sequence in this document:

1. Cache `dev.galatadergisi.org` while the dev release is being tested, if
   desired.
2. Keep `galatadergisi.org` and `www.galatadergisi.org` out of every new rule
   while they still serve the current main-branch release.
3. Promote the dev release to the production slot.
4. Only after that promotion succeeds, add the apex and `www` hostnames to the
   rules.

The cacheable HTML documents covered here are:

- `GET /`
- `GET /katkida-bulunun`

The contribution submission endpoint, `POST /katkida-bulunun`, is always
bypassed. Its validation, Turnstile verification, rate limiting, upload, and
`Cache-Control: no-store` behavior must continue to run at the origin.

## Preconditions

- The three hostnames are proxied through Cloudflare.
- The remotely managed Tunnel routes each hostname to the tracked nginx
  listener.
- `dev.galatadergisi.org` remains protected by a full-host Cloudflare Access
  application with **Protect with Access** enabled. Do not add an Access bypass
  policy for caching.
- The production rollout and rollback procedures in
  [`docs/immutable-site-operations.md`](../../docs/immutable-site-operations.md)
  have been tested.
- Browser responses for HTML continue to use the origin's
  `public, max-age=0, must-revalidate` policy. This runbook overrides only the
  edge TTL for HTML.

Before configuring caching on the dev hostname, verify from an unauthenticated
private browser session that this URL redirects to Cloudflare Access:

```text
https://dev.galatadergisi.org/healthz
```

Repeat that check after configuring the rules. A cached object must never make
the dev hostname accessible without Access authorization.

## Host filter and rollout gate

Use this filter while the apex and `www` hostnames still run the main branch:

```text
http.host eq "dev.galatadergisi.org"
```

After the dev release has been promoted successfully, replace it with:

```text
http.host in {
  "galatadergisi.org"
  "www.galatadergisi.org"
  "dev.galatadergisi.org"
}
```

The post-rollout rules may be prepared with **Save as Draft**. Do not deploy a
rule containing either production hostname before the promotion.

Keep Cloudflare's default cache key. It contains the full URL, including the
hostname and query string, so the public production hosts and the
Access-protected dev host receive separate cache objects. Do not add a custom
cache key.

## Rule 1: cache the homepage and contribution form

Create a Cache Rule named `Galata release HTML`.

Use the dev-only expression before rollout:

```text
http.host eq "dev.galatadergisi.org"
and http.request.method in {"GET" "PURGE"}
and http.request.uri.path in {"/" "/katkida-bulunun"}
```

After rollout, change only the hostname portion:

```text
http.host in {
  "galatadergisi.org"
  "www.galatadergisi.org"
  "dev.galatadergisi.org"
}
and http.request.method in {"GET" "PURGE"}
and http.request.uri.path in {"/" "/katkida-bulunun"}
```

Configure the rule as follows:

| Setting | Value |
| --- | --- |
| Cache eligibility | Eligible for cache |
| Browser TTL | Respect origin |
| Cache deception armor | Enabled |
| Cache key components | Keep defaults |

The `PURGE` method is included because Cloudflare's single-file purge is
evaluated against Cache Rule expressions. A rule restricted to `GET` alone may
not match a dashboard purge. `PURGE` does not make application submissions
cacheable; Cloudflare's normal cache only stores eligible `GET` responses, and
the Go server rejects unsupported methods.

The homepage and contribution document do not vary by query string, but this
rule deliberately retains the default query-string key. Do not add cookies,
including `CF_Authorization`, to the cache key: these documents are not
personalized. Access must still authorize every request to the dev hostname
before content is delivered.

If either document later becomes user-specific, remove it from this rule before
deploying that change.

## Rule 2: cache versioned first-load assets

Create a Cache Rule named `Galata release assets`.

The release uses `?v=<content digest>` for stable asset paths and content hashes
in generated homepage AVIF filenames. The contribution page's local CSS and
JavaScript use the same versioning scheme.

Use this expression before rollout:

```text
http.host eq "dev.galatadergisi.org"
and http.request.method in {"GET" "PURGE"}
and (
  starts_with(http.request.uri.path, "/images/homepage-covers/")
  or (
    http.request.uri.query contains "v="
    and (
      http.request.uri.path in {"/bundle.css" "/bundle.js" "/global.css"}
      or starts_with(http.request.uri.path, "/images/")
      or starts_with(http.request.uri.path, "/katkida-bulunun/")
    )
  )
)
```

After rollout, replace the first line with the three-host post-rollout filter:

```text
http.host in {
  "galatadergisi.org"
  "www.galatadergisi.org"
  "dev.galatadergisi.org"
}
and http.request.method in {"GET" "PURGE"}
and (
  starts_with(http.request.uri.path, "/images/homepage-covers/")
  or (
    http.request.uri.query contains "v="
    and (
      http.request.uri.path in {"/bundle.css" "/bundle.js" "/global.css"}
      or starts_with(http.request.uri.path, "/images/")
      or starts_with(http.request.uri.path, "/katkida-bulunun/")
    )
  )
)
```

Configure the asset rule as follows:

| Setting | Value |
| --- | --- |
| Cache eligibility | Eligible for cache |
| Browser TTL | Respect origin |
| Cache deception armor | Enabled |
| Cache key components | Keep defaults |

Never change the cache key for this rule. A new `v` value must create a new
cache object. Content-hashed AVIF filenames are independently safe to retain for
one year. The one-year edge and browser TTL is applied to successful responses
by the Cache Response Rule below.

Cloudflare cannot cache the contribution page's third-party Materialize and
Turnstile resources under this zone. Those services control their own caching.

## Rule 3: bypass runtime and write requests

Create this rule last and name it `Galata runtime bypass`. Later matching Cache
Rules win when settings conflict, so keeping this rule last preserves the
bypass if a broader cache rule is added in the future.

Use the dev-only expression before rollout:

```text
http.host eq "dev.galatadergisi.org"
and (
  http.request.uri.path in {"/healthz" "/service-worker.js"}
  or not (http.request.method in {"GET" "HEAD" "PURGE"})
)
```

After rollout, use:

```text
http.host in {
  "galatadergisi.org"
  "www.galatadergisi.org"
  "dev.galatadergisi.org"
}
and (
  http.request.uri.path in {"/healthz" "/service-worker.js"}
  or not (http.request.method in {"GET" "HEAD" "PURGE"})
)
```

Set **Cache eligibility** to **Bypass cache**. In particular, this matches
`POST /katkida-bulunun` and prevents a future broad cache rule from overriding
the submission handler's `no-store` policy.

Do not give `/service-worker.js` a long edge or browser TTL. The unversioned
service-worker URL must revalidate so a newly deployed release can take control.

## Rule order

Keep the rules in this order:

1. `Galata release HTML`
2. `Galata release assets`
3. `Galata runtime bypass`

The current expressions do not intentionally overlap except for defensive
bypass behavior. The last rule is nevertheless the safety boundary for writes,
health checks, and service-worker rollout.

## Cache Response Rules

Create the following three Cache Response Rules. These rules run after the
origin responds, so they can apply long TTLs only to successful responses and
prevent redirects and error documents from entering either the Cloudflare or
browser cache.

Use `http.host eq "dev.galatadergisi.org"` as the first line of every expression
before rollout. After the release has been promoted, replace only that first
line with the three-host filter from [Host filter and rollout
gate](#host-filter-and-rollout-gate).

### Response Rule 1: successful HTML

Create a Cache Response Rule named `Galata successful HTML TTL` with this
dev-only expression:

```text
http.host eq "dev.galatadergisi.org"
and http.request.method eq "GET"
and http.request.uri.path in {"/" "/katkida-bulunun"}
and (
  (http.response.code ge 200 and http.response.code le 299)
  or http.response.code eq 304
)
```

Add a **Cache-Control** modification with these values:

| Setting | Value |
| --- | --- |
| Directive | `max-age` |
| Operation | Set |
| Duration | 30 days (`2592000` seconds) |
| Cloudflare only | Enabled |

The Cloudflare-only setting gives the edge a 30-day TTL while the browser still
receives the origin's `public, max-age=0, must-revalidate` policy.

### Response Rule 2: successful versioned assets

Create a Cache Response Rule named `Galata successful asset TTL` with this
dev-only expression:

```text
http.host eq "dev.galatadergisi.org"
and http.request.method eq "GET"
and (
  starts_with(http.request.uri.path, "/images/homepage-covers/")
  or (
    http.request.uri.query contains "v="
    and (
      http.request.uri.path in {"/bundle.css" "/bundle.js" "/global.css"}
      or starts_with(http.request.uri.path, "/images/")
      or starts_with(http.request.uri.path, "/katkida-bulunun/")
    )
  )
)
and (
  (http.response.code ge 200 and http.response.code le 299)
  or http.response.code eq 304
)
```

Add these **Cache-Control** modifications so browsers and Cloudflare receive the
same policy.

| Directive | Operation | Duration | Cloudflare only |
| --- | --- | --- | --- |
| `max-age` | Set | 1 year (`31536000` seconds) | Disabled |
| `public` | Set | — | Disabled |
| `immutable` | Set | — | Disabled |

Only versioned or content-hashed assets match this rule, so retaining a
successful response for one year is safe.

### Response Rule 3: do not store non-success responses

Create this rule last and name it `Galata non-success no-store`. Use this
dev-only expression:

```text
http.host eq "dev.galatadergisi.org"
and http.request.method eq "GET"
and (
  http.request.uri.path in {"/" "/katkida-bulunun"}
  or starts_with(http.request.uri.path, "/images/homepage-covers/")
  or (
    http.request.uri.query contains "v="
    and (
      http.request.uri.path in {"/bundle.css" "/bundle.js" "/global.css"}
      or starts_with(http.request.uri.path, "/images/")
      or starts_with(http.request.uri.path, "/katkida-bulunun/")
    )
  )
)
and http.response.code ge 300
and http.response.code le 599
and http.response.code ne 304
```

Configure the rule as follows:

| Setting | Value |
| --- | --- |
| Directive | `no-store` |
| Operation | Set |
| Cloudflare only | Disabled |

This prevents redirects, client errors, and origin errors from being stored at
the edge or in a browser. A `304 Not Modified` response is excluded because it
revalidates an existing successful cache object rather than replacing it with
an error document.

## Cache Response Rule order

Keep the Cache Response Rules in this order:

1. `Galata successful HTML TTL`
2. `Galata successful asset TTL`
3. `Galata non-success no-store`

## Production activation sequence

Follow this order so the current main-branch production release is never
cached by the new HTML rule:

1. Keep all three Cache Rules and all three Cache Response Rules limited to
   `dev.galatadergisi.org` or saved as drafts.
2. Deploy and verify the dev-branch release in the dev slot.
3. Promote that exact immutable release to the production slot.
4. Verify the new release directly on both public hostnames before enabling the
   production host filters.
5. Add `galatadergisi.org` and `www.galatadergisi.org` to all six rules.
6. Purge the HTML URLs listed below.
7. Prime and verify each public hostname with real `GET` requests.
8. Recheck contribution submission handling and the dev Access gate.

Do not enable the production filters before step 3. Enabling caching after the
promotion may leave a short interval in which the new release is served from
the origin, which is safe and preferable to caching the old release.

## Purging after each deployment

Purge these exact URLs after every production-slot deployment:

```text
https://galatadergisi.org/
https://galatadergisi.org/katkida-bulunun
https://www.galatadergisi.org/
https://www.galatadergisi.org/katkida-bulunun
```

If the dev hostname was updated, also purge:

```text
https://dev.galatadergisi.org/
https://dev.galatadergisi.org/katkida-bulunun
```

Use **Caching > Configuration > Custom Purge > URL**. Do not use **Purge
Everything** for a normal deployment. Versioned and content-hashed assets do
not need purging because a changed file receives a new cache key or filename.

Cloudflare recommends single-file purging. The `PURGE` method in the rule
expressions is intentional and should not be removed unless the deployment
process switches to a purge mechanism that does not re-evaluate these request
conditions.

## Verification

Do not use `curl -I` for the primary cache test because it sends `HEAD`, while
the cache-fill rules intentionally match `GET`. Use a real GET and discard the
body:

```sh
curl -sS -D - -o /dev/null https://galatadergisi.org/
curl -sS -D - -o /dev/null https://galatadergisi.org/

curl -sS -D - -o /dev/null https://galatadergisi.org/katkida-bulunun
curl -sS -D - -o /dev/null https://galatadergisi.org/katkida-bulunun
```

After a purge, the first response will normally contain
`CF-Cache-Status: MISS`; the next request to the same Cloudflare location should
contain `CF-Cache-Status: HIT` and an `Age` header. An already-warm cache may
return `HIT` immediately.

For HTML, confirm the browser-facing `Cache-Control` header still contains the
origin's revalidation policy rather than a 30-day browser TTL. Then select one
versioned local asset from the page and request it twice. Confirm the second
asset response is a `HIT` and its browser-facing `Cache-Control` header contains
`max-age=31536000` and `immutable`.

Repeat the checks for `www`. Test the dev hostname from an authenticated browser
session and inspect the Network panel rather than copying an Access token into
shell history.

Verify the contribution POST without creating a real contribution:

1. Open `/katkida-bulunun` in a browser and confirm the document and local
   versioned bundles load normally.
2. Submit an intentionally incomplete form or inspect a normal validation
   failure.
3. Confirm the POST response is `DYNAMIC` or `BYPASS`, not `HIT`.
4. Confirm the POST response retains `Cache-Control: no-store`.
5. Confirm Turnstile still renders and a valid test submission can be accepted
   during the formal release acceptance procedure.

Finally, repeat the unauthenticated `dev.galatadergisi.org/healthz` check. It
must still redirect to Cloudflare Access.

## Rollback

If the production release is rolled back to the current main-branch build:

1. Remove `galatadergisi.org` and `www.galatadergisi.org` from all six rules
   before or immediately with the rollback.
2. Purge the four production HTML URLs.
3. Verify that the apex and `www` HTML responses are no longer served from the
   new rules.
4. Leave the dev-only rules enabled only if the dev hostname still serves the
   compatible dev release.

This restores the original production caching behavior without changing the
dev hostname.

## Features deliberately excluded

This runbook does not change zone-wide HTTP/3, TLS, compression, Tiered Cache,
Rocket Loader, or Early Hints settings. A zone-wide setting could affect the
current production site before rollout. Evaluate those features separately
after the dev release owns the production hostnames.

The generated homepage images are already responsive AVIFs, the bundles are
already minified, and the origin does not currently emit the HTTP `Link`
headers required for useful Early Hints. Rocket Loader and additional image
rewriting are therefore not part of this caching change.

## Cloudflare references

- [Cache Rules](https://developers.cloudflare.com/cache/how-to/cache-rules/)
- [Cache Rule settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/)
- [Cache Response Rules](https://developers.cloudflare.com/cache/how-to/cache-response-rules/)
- [Cache Response Rule settings](https://developers.cloudflare.com/cache/how-to/cache-response-rules/settings/)
- [Cache keys](https://developers.cloudflare.com/cache/how-to/cache-keys/)
- [Default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)
- [Edge and browser cache TTL](https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/)
- [Single-file purge](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
