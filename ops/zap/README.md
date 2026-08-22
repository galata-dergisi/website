# OWASP ZAP production-boundary scans

The primary harness builds the generated public site, production Go binary,
and tracked production nginx vhost. It runs the official ZAP packaged scans
against `http://galatadergisi.org:8080` on an internal Docker network. Neither
the Go server nor nginx publishes a host port, and the network has no external
connectivity.

Run the primary nginx-to-Go scans from the repository root:

```sh
npm run security:zap
npm run security:zap:active
```

These write `zap-report.*` and `zap-active-report.*` under the ignored
`zap-reports/` directory. The baseline performs a time-limited spider and
passive analysis. The bounded active command sends attack payloads only to the
isolated target.

Direct-Go scans remain available as explicit origin diagnostics:

```sh
npm run security:zap:origin
npm run security:zap:active:origin
```

They write `zap-origin-report.*` and `zap-origin-active-report.*`. Their rule
policies ignore the HSTS, clickjacking, and nosniff headers deliberately owned
by nginx. The primary policies fail when any of those headers are missing.
During the staged CSP rollout, rule 10038 remains informational because the
deployed vhosts emit the exact independently verified report-only policy. It
must be promoted to `FAIL` after production enforcement. Rule 10055 remains
informational for the reviewed `style-src-attr 'unsafe-inline'` exception; the
generated-site verifier enforces the complete policy and exact hashes.

The shared scan hook excludes `/images/sayiN/` and
`/magazines/sayiN/audio/` from both spidering and active attacks. Those payloads
belong to the separately deployed media repository, which is neither mounted
nor required by this harness.

The official stable ZAP image is used by default. Scanner and timeout limits
can be overridden without changing the target boundary:

```sh
ZAP_SPIDER_MINUTES=2 ZAP_TIMEOUT_MINUTES=15 npm run security:zap
ZAP_ACTIVE_SPIDER_MINUTES=2 ZAP_ACTIVE_TIMEOUT_MINUTES=15 \
ZAP_ACTIVE_MAX_DURATION_MINUTES=20 \
ZAP_ACTIVE_MAX_RULE_DURATION_MINUTES=3 \
  npm run security:zap:active
```

ZAP runs in silent mode so it does not attempt add-on updates or call-home
requests. To test an image update or a reviewed digest:

```sh
ZAP_IMAGE=ghcr.io/zaproxy/zaproxy:stable npm run security:zap
```
