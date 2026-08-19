#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
compose_file="$repo_root/ops/local-production/compose.yaml"
env_file="$repo_root/.env.production"

run_compose() {
  if [ -f "$env_file" ]; then
    docker compose --env-file "$env_file" -f "$compose_file" "$@"
  else
    docker compose -f "$compose_file" "$@"
  fi
}

case "${1:-}" in
  up)
    run_compose up --build
    ;;
  down)
    run_compose down --remove-orphans
    ;;
  *)
    echo "Usage: $0 {up|down}" >&2
    exit 2
    ;;
esac
