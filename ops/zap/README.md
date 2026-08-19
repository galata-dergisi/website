# OWASP ZAP production-mode scan

This harness builds the generated public site and `cmd/galata-server` with the
repository's pinned Node and Go versions, starts that production binary on an
isolated Docker network, and runs official ZAP packaged scans against it. The
development watcher and `cmd/galata-dev` are never included.

Run it from the repository root:

```sh
npm run security:zap
npm run security:zap:active
```

The command requires Docker with Compose support. It creates these ignored
artifacts under `zap-reports/`:

- `zap-report.html`
- `zap-report.json`
- `zap-report.md`
- `zap-active-report.html`
- `zap-active-report.json`
- `zap-active-report.md`

`security:zap` runs the time-limited baseline spider and passive analysis; it
does not launch an active attack. `security:zap:active` runs the modern spider
and a full active scan, which sends attack payloads to the target and can take
longer. The target has no published host port and the scan network has no
external connectivity.

Before either scan starts, the harness verifies the production contribution
endpoint's CAPTCHA boundary: an otherwise valid multipart submission without
`cf-turnstile-response` must return `400 captcha_required`, and a filled
`contactWebsite` honeypot with a fake token must return the generic
`400 captcha_invalid`. The latter check proves the request is rejected before
Turnstile verification. The isolated harness uses a placeholder secret only
to satisfy production startup and never contacts Cloudflare during these
contract checks.

`baseline.conf` promotes reviewed, high-confidence disclosures to `FAIL`.
Warnings are retained in the reports without failing the command, and rules
not yet classified in the configuration are reported as informational. Review
new findings and promote actionable rules instead of suppressing them in the
runner.

`active.conf` makes unclassified findings fail the active command at ZAP's
default `WARN` level. Reviewed current or environment-specific findings are
`INFO` or `IGNORE`, and high-impact injection rules are promoted to `FAIL`.
Generated reports preserve ZAP's underlying risk ratings even when the command
policy classifies a known finding as informational or ignored.

The Go application is scanned directly. TLS termination and the response
headers added by `ops/nginx/galatadergisi.org.conf` are therefore explicitly
out of scope in the rule configurations and remain covered by production
configuration review.

The active scan defaults to `/katkida-bulunun`, the production application's
only public write surface. It is bounded to ten minutes in total and two
minutes per rule. Change the target or limits explicitly when broader coverage
is warranted:

```sh
ZAP_ACTIVE_TARGET=http://app:3000 \
ZAP_ACTIVE_MAX_DURATION_MINUTES=20 \
ZAP_ACTIVE_MAX_RULE_DURATION_MINUTES=3 \
  npm run security:zap:active
```

The official stable ZAP image is used by default. Spider and startup/passive
timeouts can also be overridden when troubleshooting. ZAP runs in silent mode
so the isolated scan does not attempt add-on updates or call-home requests:

```sh
ZAP_SPIDER_MINUTES=2 ZAP_TIMEOUT_MINUTES=15 npm run security:zap
ZAP_ACTIVE_SPIDER_MINUTES=2 ZAP_ACTIVE_TIMEOUT_MINUTES=15 \
  npm run security:zap:active
```

To test an image update or pin a reviewed image digest:

```sh
ZAP_IMAGE=ghcr.io/zaproxy/zaproxy:stable npm run security:zap
```
