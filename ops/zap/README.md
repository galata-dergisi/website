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

The command requires Docker with Compose support. It writes ignored HTML, JSON,
and Markdown reports under `zap-reports/`. The baseline command performs a
time-limited spider and passive analysis. The explicit active command sends
attack payloads to the isolated target and can take longer.

`baseline.conf` promotes reviewed, high-confidence disclosures to `FAIL`.
Warnings remain in the reports without failing the command, and unclassified
rules are informational. `active.conf` makes unclassified findings fail at
ZAP's default `WARN` level; reviewed environment-specific findings are
`INFO` or `IGNORE`, and high-impact injection rules are `FAIL`.

The Go application is scanned directly. TLS termination and response headers
added by `ops/nginx/galatadergisi.org.conf` are outside this harness and remain
covered by production configuration review. The target has no public write
endpoint, no published host port, and no external network connectivity.

The active scan defaults to the homepage and is bounded to ten minutes in total
and two minutes per rule. Change the target or limits explicitly when broader
coverage is warranted:

```sh
ZAP_ACTIVE_TARGET=http://app:3000/dergiler/sayi47 \
ZAP_ACTIVE_MAX_DURATION_MINUTES=20 \
ZAP_ACTIVE_MAX_RULE_DURATION_MINUTES=3 \
  npm run security:zap:active
```

The official stable ZAP image is used by default. Spider and startup/passive
timeouts can also be overridden. ZAP runs in silent mode so the isolated scan
does not attempt add-on updates or call-home requests:

```sh
ZAP_SPIDER_MINUTES=2 ZAP_TIMEOUT_MINUTES=15 npm run security:zap
ZAP_ACTIVE_SPIDER_MINUTES=2 ZAP_ACTIVE_TIMEOUT_MINUTES=15 \
  npm run security:zap:active
```

To test an image update or pin a reviewed image digest:

```sh
ZAP_IMAGE=ghcr.io/zaproxy/zaproxy:stable npm run security:zap
```
