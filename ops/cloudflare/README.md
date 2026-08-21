# Cloudflare caching for Galata Dergisi

This runbook describes the cache rules shared by
`galatadergisi.org`, `www.galatadergisi.org`, and the Access-protected
`dev.galatadergisi.org` deployment. Cloudflare cannot match a Git branch, so
keep rules limited to the dev hostname until the exact tested release is
promoted to production.

## Host filters

Use this filter while validating a release on dev:

```text
http.host eq "dev.galatadergisi.org"
```

After promotion, replace only the host portion with:

```text
http.host in {
  "galatadergisi.org"
  "www.galatadergisi.org"
  "dev.galatadergisi.org"
}
```

Keep Cloudflare's default cache key. It includes the hostname and query string,
so production and Access-protected dev objects remain separate.

## Cache Rules

Create these rules in order.

### 1. Galata release HTML

Dev-only expression:

```text
http.host eq "dev.galatadergisi.org"
and http.request.method in {"GET" "PURGE"}
and http.request.uri.path eq "/"
```

Set:

- Cache eligibility: **Eligible for cache**
- Browser TTL: **Respect origin**
- Cache deception armor: **Enabled**
- Cache key: default

`PURGE` is included because single-file purges are evaluated against Cache
Rule expressions. Normal cache storage still applies only to eligible GET
responses.

### 2. Galata release assets

Dev-only expression:

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
    )
  )
)
```

Set:

- Cache eligibility: **Eligible for cache**
- Browser TTL: **Respect origin**
- Cache deception armor: **Enabled**
- Cache key: default

The query-versioned and content-hashed paths are safe for the one-year
successful-response policy below.

### 3. Galata runtime bypass

Keep this rule last:

```text
http.host eq "dev.galatadergisi.org"
and (
  http.request.uri.path in {"/healthz" "/service-worker.js"}
  or not (http.request.method in {"GET" "HEAD" "PURGE"})
)
```

Set **Cache eligibility** to **Bypass cache**. The service worker and health
endpoint must revalidate at the origin, and unsupported write methods should
never become cacheable through a future broad rule.

After production promotion, replace the first host line of all three rules with
the three-host filter above.

## Cache Response Rules

Create these response rules in order. As with Cache Rules, start with the dev
host and add production hosts only after promotion.

### 1. Galata successful HTML TTL

```text
http.host eq "dev.galatadergisi.org"
and http.request.method eq "GET"
and http.request.uri.path eq "/"
and (
  (http.response.code ge 200 and http.response.code le 299)
  or http.response.code eq 304
)
```

Modify `Cache-Control`:

- Directive: `max-age`
- Operation: **Set**
- Duration: 30 days (`2592000` seconds)
- Cloudflare only: **Enabled**

The browser continues to receive the origin's revalidation policy.

### 2. Galata successful asset TTL

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
    )
  )
)
and (
  (http.response.code ge 200 and http.response.code le 299)
  or http.response.code eq 304
)
```

Modify `Cache-Control`:

| Directive | Operation | Duration | Cloudflare only |
| --- | --- | --- | --- |
| `max-age` | Set | 1 year (`31536000`) | Disabled |
| `public` | Set | — | Disabled |
| `immutable` | Set | — | Disabled |

### 3. Galata non-success no-store

Keep this response rule last:

```text
http.host eq "dev.galatadergisi.org"
and http.request.method eq "GET"
and (
  http.request.uri.path eq "/"
  or starts_with(http.request.uri.path, "/images/homepage-covers/")
  or (
    http.request.uri.query contains "v="
    and (
      http.request.uri.path in {"/bundle.css" "/bundle.js" "/global.css"}
      or starts_with(http.request.uri.path, "/images/")
    )
  )
)
and http.response.code ge 300
and http.response.code le 599
and http.response.code ne 304
```

Set the `no-store` directive with **Cloudflare only** disabled. This prevents
redirects and error documents from entering either the edge or browser cache.

## Submission-form retirement

When deploying the release that removes the old submission form:

1. Remove `/katkida-bulunun` and
   `starts_with(http.request.uri.path, "/katkida-bulunun/")` from every Cache
   Rule and Cache Response Rule. The expressions above are the resulting
   configuration.
2. Purge these exact URLs once, after saving the rules and deploying the
   release:

   ```text
   https://galatadergisi.org/katkida-bulunun
   https://www.galatadergisi.org/katkida-bulunun
   https://dev.galatadergisi.org/katkida-bulunun
   ```

3. Delete the Turnstile widget previously used by the form after the production
   release is verified. Retaining it provides no application protection once
   the endpoint is gone.
4. Remove any separately configured WAF, rate-limiting, redirect, or Access
   rule that targets only `/katkida-bulunun`. The tracked origin configuration
   no longer requires a route-specific edge rule.

Do not redirect the retired path unless the editorial decision changes. The
deployed application intentionally returns `404` for GET and rejects POST.

## Deployment purge and verification

For normal releases, purge only the homepage URLs whose HTML was replaced:

```text
https://galatadergisi.org/
https://www.galatadergisi.org/
https://dev.galatadergisi.org/
```

Use **Custom Purge by URL**, not **Purge Everything**. Versioned assets do not
need purging.

Verify the homepage with two real GET requests. After a purge, the first will
normally be `MISS`; the next request from the same Cloudflare location should
be `HIT` with an `Age` header. Confirm browser-facing HTML still uses the
origin revalidation policy, while a versioned local asset uses
`max-age=31536000` and `immutable`.

For the retirement release, also verify:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://galatadergisi.org/katkida-bulunun
curl -sS -X POST -o /dev/null -w '%{http_code}\n' \
  https://galatadergisi.org/katkida-bulunun
```

The expected statuses are `404` and `405`. Repeat for `www`. Test dev from
an authenticated browser and separately confirm an unauthenticated
`dev.galatadergisi.org/healthz` request still redirects to Cloudflare Access.

## References

- [Cache Rules](https://developers.cloudflare.com/cache/how-to/cache-rules/)
- [Cache Response Rules](https://developers.cloudflare.com/cache/how-to/cache-response-rules/)
- [Single-file purge](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
