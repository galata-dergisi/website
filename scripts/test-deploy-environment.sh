#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
dockerfile="$repo_root/ops/deploy-test/Dockerfile"
image=galata-deploy-environment-test:local
container="galata-deploy-environment-test-$$"

cleanup() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    docker logs "$container" >&2 2>/dev/null || true
    docker exec "$container" journalctl --no-pager -n 200 >&2 2>/dev/null || true
  fi
  docker rm --force "$container" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  printf 'Docker is required to run the deployment environment test.\n' >&2
  exit 1
fi

docker build --quiet --file "$dockerfile" --tag "$image" "$repo_root"
docker run --detach --privileged \
  --name "$container" \
  --tmpfs /run \
  --tmpfs /run/lock \
  "$image" >/dev/null

attempt=1
while [ "$attempt" -le 60 ]; do
  state=$(docker exec "$container" systemctl is-system-running 2>/dev/null || true)
  case "$state" in
    running|degraded) break ;;
  esac
  sleep 1
  attempt=$((attempt + 1))
done
[ "$attempt" -le 60 ] || {
  printf 'The Ubuntu systemd test container did not become ready.\n' >&2
  exit 1
}

docker exec "$container" /usr/local/sbin/run-galata-deploy-test
