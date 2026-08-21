#!/bin/sh
set -eu

target="${ZAP_TARGET:-http://app:3000}"
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
  -c /zap/config/baseline.conf \
  -m "${ZAP_SPIDER_MINUTES:-1}" \
  -T "${ZAP_TIMEOUT_MINUTES:-10}" \
  -i \
  -I \
  -z "-silent" \
  -r zap-report.html \
  -J zap-report.json \
  -w zap-report.md
