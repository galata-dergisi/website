#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
compose_file="$repo_root/ops/zap/compose.yaml"
report_dir="$repo_root/zap-reports"
scan_mode="${1:-baseline}"
scan_boundary="${2:-nginx}"

case "$scan_mode" in
  baseline)
    compose_profile=baseline
    scan_service=zap
    ;;
  active)
    compose_profile=active
    scan_service=zap-active
    ;;
  *)
    echo "Usage: $0 [baseline|active] [nginx|origin]" >&2
    exit 1
    ;;
esac

case "$scan_boundary" in
  nginx)
    ZAP_APP_LISTEN_ADDR=127.0.0.1:3000
    ZAP_TARGET=http://galatadergisi.org:8080
    case "$scan_mode" in
      baseline)
        ZAP_RULE_CONFIG=/zap/config/baseline.conf
        ZAP_REPORT_STEM=zap-report
        ;;
      active)
        ZAP_RULE_CONFIG=/zap/config/active.conf
        ZAP_REPORT_STEM=zap-active-report
        ;;
    esac
    set -- nginx "$scan_service"
    ;;
  origin)
    ZAP_APP_LISTEN_ADDR=0.0.0.0:3000
    ZAP_TARGET=http://app:3000
    case "$scan_mode" in
      baseline)
        ZAP_RULE_CONFIG=/zap/config/origin-baseline.conf
        ZAP_REPORT_STEM=zap-origin-report
        ;;
      active)
        ZAP_RULE_CONFIG=/zap/config/origin-active.conf
        ZAP_REPORT_STEM=zap-origin-active-report
        ;;
    esac
    set -- "$scan_service"
    ;;
  *)
    echo "Usage: $0 [baseline|active] [nginx|origin]" >&2
    exit 1
    ;;
esac
ZAP_ACTIVE_TARGET="${ZAP_TARGET}/"
export ZAP_ACTIVE_TARGET ZAP_APP_LISTEN_ADDR ZAP_REPORT_STEM ZAP_RULE_CONFIG ZAP_TARGET

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to run the OWASP ZAP scan." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is required to run the OWASP ZAP scan." >&2
  exit 1
fi

mkdir -p "$report_dir"

cleanup() {
  docker compose --profile "$compose_profile" -f "$compose_file" \
    down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

docker compose --profile "$compose_profile" -f "$compose_file" up \
  --build \
  --abort-on-container-exit \
  --exit-code-from "$scan_service" \
  "$@"
