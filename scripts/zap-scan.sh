#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
compose_file="$repo_root/ops/zap/compose.yaml"
report_dir="$repo_root/zap-reports"
scan_mode="${1:-baseline}"

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
    echo "Usage: $0 [baseline|active]" >&2
    exit 1
    ;;
esac

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
  "$scan_service"
