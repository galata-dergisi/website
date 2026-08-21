#!/bin/sh
set -eu

target="${ZAP_TARGET:-http://app:3000}"
active_target="${ZAP_ACTIVE_TARGET:-${target}/}"
spider_minutes="${ZAP_ACTIVE_SPIDER_MINUTES:-1}"
timeout_minutes="${ZAP_ACTIVE_TIMEOUT_MINUTES:-10}"
max_duration_minutes="${ZAP_ACTIVE_MAX_DURATION_MINUTES:-10}"
max_rule_duration_minutes="${ZAP_ACTIVE_MAX_RULE_DURATION_MINUTES:-2}"
attempt=1
max_attempts=60

for value in \
  "$spider_minutes" \
  "$timeout_minutes" \
  "$max_duration_minutes" \
  "$max_rule_duration_minutes"
do
  case "$value" in
    ''|*[!0-9]*)
      echo "ZAP active-scan durations must be positive whole minutes." >&2
      exit 3
      ;;
  esac
  if [ "$value" -eq 0 ]; then
    echo "ZAP active-scan durations must be positive whole minutes." >&2
    exit 3
  fi
done

while ! curl --fail --silent --show-error --max-time 2 "${target}/healthz" >/dev/null; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "Production-mode target did not become ready at ${target}." >&2
    exit 3
  fi
  attempt=$((attempt + 1))
  sleep 1
done

exec zap-full-scan.py \
  -t "$active_target" \
  -c /zap/config/active.conf \
  -m "$spider_minutes" \
  -T "$timeout_minutes" \
  -j \
  -z "-silent -config scanner.maxScanDurationInMins=${max_duration_minutes} -config scanner.maxRuleDurationInMins=${max_rule_duration_minutes}" \
  -r zap-active-report.html \
  -J zap-active-report.json \
  -w zap-active-report.md
