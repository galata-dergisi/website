#!/bin/sh
set -eu

target="${ZAP_TARGET:-http://app:3000}"
rule_config="${ZAP_RULE_CONFIG:-/zap/config/baseline.conf}"
report_stem="${ZAP_REPORT_STEM:-zap-report}"
attempt=1
max_attempts=60

while ! curl --fail --silent --show-error --max-time 2 "${target}/healthz" >/dev/null; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "Production-mode target did not become ready at ${target}." >&2
    exit 3
  fi
  attempt=$((attempt + 1))
  sleep 1
done

exec zap-baseline.py \
  -t "$target" \
  -c "$rule_config" \
  -m "${ZAP_SPIDER_MINUTES:-1}" \
  -T "${ZAP_TIMEOUT_MINUTES:-10}" \
  -i \
  -I \
  --hook /zap/config/media-exclusions.py \
  -z "-silent" \
  -r "${report_stem}.html" \
  -J "${report_stem}.json" \
  -w "${report_stem}.md"
