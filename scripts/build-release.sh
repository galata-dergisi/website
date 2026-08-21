#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

die() {
  printf 'build-release: %s\n' "$*" >&2
  exit 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

[ -f internal/site/dist/manifest.json ] \
  || die "missing generated site; run 'npm run build' first"
[ -z "$(git status --porcelain --untracked-files=normal)" ] \
  || die "application checkout is dirty; release provenance requires a clean checkout"

media_root=${GALATA_MEDIA_ROOT:-}
if [ -z "$media_root" ] && [ -n "${GALATA_STATIC_ASSETS_ROOT:-}" ]; then
  media_root=$(dirname "$GALATA_STATIC_ASSETS_ROOT")
fi
if [ -z "$media_root" ]; then
  media_root=../galata-dergisi-static-assets/server-assets/public
fi
[ -d "$media_root/images" ] && [ -d "$media_root/audio" ] \
  || die "media root must contain images/ and audio/: $media_root"
[ -z "$(git -C "$media_root" status --porcelain --untracked-files=normal)" ] \
  || die "static-assets checkout is dirty; release provenance requires a clean checkout"

application_commit=$(git rev-parse HEAD)
static_assets_commit=$(git -C "$media_root" rev-parse HEAD)
embedded_site_release=$(sed -n 's/^[[:space:]]*"release": "\([0-9a-f][0-9a-f]*\)",*$/\1/p' internal/site/dist/manifest.json | head -1)
printf '%s\n' "$application_commit" "$static_assets_commit" \
  | grep -Eq '^[0-9a-f]{40}$' || die "could not read repository provenance"
printf '%s\n' "$embedded_site_release" | grep -Eq '^[0-9a-f]{16}$' \
  || die "could not read embedded site provenance"
release_id=$(printf '%.12s-%s' "$application_commit" "$embedded_site_release")

release_dir=release
mkdir -p "$release_dir"
find "$release_dir" -mindepth 1 -maxdepth 1 -delete

for architecture in amd64 arm64; do
  binary="$release_dir/galata-server-linux-$architecture"
  CGO_ENABLED=0 GOOS=linux GOARCH="$architecture" \
    go build -buildvcs=false -trimpath -ldflags="-s -w" \
    -o "$binary" ./cmd/galata-server
  go version -m "$binary" > "$binary.buildinfo"
done

(
  cd "$media_root"
  find images audio -type l -print | grep . && exit 1
  find images audio ! -type d ! -type f -print | grep . && exit 1
  find images audio -type f -print | LC_ALL=C sort | while IFS= read -r path; do
    case "$path" in
      *'
'*) die "media filenames must not contain newlines" ;;
    esac
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$path"
    else
      shasum -a 256 "$path"
    fi
  done
) > "$release_dir/MEDIA-SHA256SUMS" \
  || die "media contains a symlink, special file, or invalid filename"
[ -s "$release_dir/MEDIA-SHA256SUMS" ] || die "media inventory is empty"

node scripts/generate-cache-purge-manifest.mjs "$release_dir/CACHE-PURGE-MANIFEST" \
  || die "could not generate the cache purge manifest"

amd64_sha=$(sha256_file "$release_dir/galata-server-linux-amd64")
arm64_sha=$(sha256_file "$release_dir/galata-server-linux-arm64")
media_sha=$(sha256_file "$release_dir/MEDIA-SHA256SUMS")
cache_manifest_sha=$(sha256_file "$release_dir/CACHE-PURGE-MANIFEST")

{
  printf '%s\n' 'format=2'
  printf 'release_id=%s\n' "$release_id"
  printf 'application_commit=%s\n' "$application_commit"
  printf 'static_assets_commit=%s\n' "$static_assets_commit"
  printf 'embedded_site_release=%s\n' "$embedded_site_release"
  printf '%s\n' 'architectures=amd64,arm64'
  printf 'binary_amd64_sha256=%s\n' "$amd64_sha"
  printf 'binary_arm64_sha256=%s\n' "$arm64_sha"
  printf 'media_inventory_sha256=%s\n' "$media_sha"
  printf 'cache_purge_manifest_sha256=%s\n' "$cache_manifest_sha"
} > "$release_dir/RELEASE-MANIFEST"

(
  cd "$release_dir"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum galata-server-linux-amd64 galata-server-linux-arm64 \
      MEDIA-SHA256SUMS CACHE-PURGE-MANIFEST RELEASE-MANIFEST > SHA256SUMS
  else
    shasum -a 256 galata-server-linux-amd64 galata-server-linux-arm64 \
      MEDIA-SHA256SUMS CACHE-PURGE-MANIFEST RELEASE-MANIFEST > SHA256SUMS
  fi
)

printf 'Release %s written to %s/\n' "$release_id" "$release_dir"
