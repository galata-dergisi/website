#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
compose_file="$repo_root/ops/local-production/compose.yaml"
project="galata-production-preview-smoke-$$"
preview_port="${GALATA_PREVIEW_SMOKE_HTTPS_PORT:-44444}"
media_root="${GALATA_MEDIA_ROOT:-$repo_root/../galata-dergisi-static-assets/server-assets/public}"
temporary_dir=$(mktemp -d)
base_url="https://localhost:$preview_port"

cleanup() {
  docker compose -p "$project" -f "$compose_file" \
    down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$temporary_dir"
}
trap cleanup EXIT HUP INT TERM

fail() {
  echo "Production preview smoke test failed: $1" >&2
  docker compose -p "$project" -f "$compose_file" logs >&2 || true
  exit 1
}

assert_file_contains() {
  file=$1
  expected=$2
  label=$3
  if ! grep -F "$expected" "$file" >/dev/null; then
    fail "$label"
  fi
}

assert_status() {
  expected=$1
  actual=$2
  label=$3
  if [ "$actual" != "$expected" ]; then
    fail "$label (expected $expected, received $actual)"
  fi
}

if ! command -v docker >/dev/null 2>&1 || \
  ! docker compose version >/dev/null 2>&1
then
  echo "Docker with Compose support is required." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required." >&2
  exit 1
fi
if [ ! -d "$media_root/images" ] || [ ! -d "$media_root/audio" ]; then
  echo "Production preview media is incomplete: $media_root" >&2
  exit 1
fi

export GALATA_MEDIA_ROOT="$media_root"
export GALATA_PREVIEW_HTTPS_PORT="$preview_port"
export GALATA_PREVIEW_CSP_VARIANT=production
export GALATA_PREVIEW_ENFORCE_CSP=0

docker compose -p "$project" -f "$compose_file" config --quiet
docker compose -p "$project" -f "$compose_file" up --build --detach

ready=false
attempt=1
while [ "$attempt" -le 60 ]; do
  if curl --silent --show-error --insecure --fail --max-time 3 \
    --dump-header "$temporary_dir/health.headers" \
    "$base_url/healthz" >"$temporary_dir/health.json" 2>/dev/null
  then
    ready=true
    break
  fi
  sleep 2
  attempt=$((attempt + 1))
done
if [ "$ready" != true ]; then
  fail "HTTPS endpoint did not become healthy"
fi
assert_file_contains "$temporary_dir/health.json" '"ok":true' \
  "health response is missing ok=true"
assert_file_contains "$temporary_dir/health.json" '"release":' \
  "health response is missing the embedded release"

curl --silent --show-error --insecure --max-time 10 \
  --dump-header "$temporary_dir/home.headers" \
  --output "$temporary_dir/home.html" \
  "$base_url/"
assert_file_contains "$temporary_dir/home.headers" \
  'Strict-Transport-Security: max-age=63072000' \
  "HSTS header is missing"
assert_file_contains "$temporary_dir/home.headers" \
  'X-Frame-Options: SAMEORIGIN' \
  "frame protection header is missing"
assert_file_contains "$temporary_dir/home.headers" \
  'X-Content-Type-Options: nosniff' \
  "content-type protection header is missing"
expected_csp=$(sed -n \
  's/^add_header Content-Security-Policy-Report-Only "\(.*\)" always;$/\1/p' \
  "$repo_root/ops/nginx/galata-production-csp.conf")
actual_csp=$(awk '
  tolower($1) == "content-security-policy-report-only:" {
    sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit
  }
' "$temporary_dir/home.headers")
if [ -z "$expected_csp" ] || [ "$actual_csp" != "$expected_csp" ]; then
  fail "report-only CSP header does not match the deployed production policy"
fi
if grep -i '^Content-Security-Policy:' "$temporary_dir/home.headers" >/dev/null; then
  fail "production CSP was enforced before manual dev acceptance"
fi
assert_file_contains "$temporary_dir/health.headers" \
  'Strict-Transport-Security: max-age=63072000' \
  "health response lost inherited security headers"
assert_file_contains "$temporary_dir/health.headers" \
  'Content-Security-Policy-Report-Only:' \
  "health response lost the report-only CSP header"
assert_file_contains "$temporary_dir/home.html" \
  'rel="canonical" href="https://galatadergisi.org/' \
  "production canonical URL is missing"
if grep -F 'window.galataDevelopment' "$temporary_dir/home.html" >/dev/null; then
  fail "development rendering marker exists in production HTML"
fi

curl --silent --show-error --insecure --max-time 10 \
  --output "$temporary_dir/legacy-video.html" \
  "$base_url/dergiler/sayi45/34"
assert_file_contains "$temporary_dir/legacy-video.html" \
  '/assets/legacy/sayi45-page34.css?v=' \
  "legacy video stylesheet is not externalized"
assert_file_contains "$temporary_dir/legacy-video.html" \
  '/assets/legacy/sayi45-page34.js?v=' \
  "legacy video script is not externalized"
if grep -i '<style' "$temporary_dir/legacy-video.html" >/dev/null; then
  fail "legacy video page retains an inline style element"
fi

curl --silent --show-error --insecure --max-time 10 \
  --output "$temporary_dir/profile.html" \
  "$base_url/katkida-bulunanlar/15-nafizcan-onder"
assert_file_contains "$temporary_dir/profile.html" \
  '/assets/contributor-profile.css?v=' \
  "contributor profile stylesheet is not externalized"
assert_file_contains "$temporary_dir/profile.html" \
  '/assets/contributor-profile.js?v=' \
  "contributor profile script is not externalized"
if grep -i '<style' "$temporary_dir/profile.html" >/dev/null; then
  fail "contributor profile retains an inline style element"
fi

curl --silent --show-error --insecure --max-time 10 \
  --dump-header "$temporary_dir/legacy-css.headers" \
  --output /dev/null \
  "$base_url/assets/legacy/sayi45-page34.css"
assert_file_contains "$temporary_dir/legacy-css.headers" 'Content-Type: text/css' \
  "legacy stylesheet content type is incorrect"
curl --silent --show-error --insecure --max-time 10 \
  --dump-header "$temporary_dir/profile-js.headers" \
  --output /dev/null \
  "$base_url/assets/contributor-profile.js"
assert_file_contains "$temporary_dir/profile-js.headers" \
  'Content-Type: text/javascript' \
  "contributor profile script content type is incorrect"

curl --silent --show-error --insecure --max-time 10 \
  --header 'Accept-Encoding: gzip' \
  --dump-header "$temporary_dir/gzip.headers" \
  --output /dev/null \
  "$base_url/"
assert_file_contains "$temporary_dir/gzip.headers" 'Content-Encoding: gzip' \
  "gzip response encoding is missing"

etag=$(awk 'tolower($1) == "etag:" { sub(/\r$/, "", $2); print $2; exit }' \
  "$temporary_dir/home.headers")
if [ -z "$etag" ]; then
  fail "homepage ETag is missing"
fi
status=$(curl --silent --show-error --insecure --max-time 10 \
  --output /dev/null --write-out '%{http_code}' \
  --header "If-None-Match: $etag" "$base_url/")
assert_status 304 "$status" "conditional homepage request"

status=$(curl --silent --show-error --insecure --max-time 10 \
  --head --output /dev/null --write-out '%{http_code}' "$base_url/")
assert_status 200 "$status" "homepage HEAD request"

status=$(curl --silent --show-error --insecure --max-time 10 \
  --output /dev/null --write-out '%{http_code}' \
  "$base_url/images/sayi1/thumbnail.jpg")
assert_status 200 "$status" "nginx image response"

audio_url="$base_url/magazines/sayi36/audio/1.mp3"
curl --silent --show-error --insecure --max-time 10 \
  --head --dump-header "$temporary_dir/audio-head.headers" \
  --output /dev/null "$audio_url"
assert_file_contains "$temporary_dir/audio-head.headers" 'Accept-Ranges: bytes' \
  "nginx audio Accept-Ranges header is missing"
assert_file_contains "$temporary_dir/audio-head.headers" \
  'X-Content-Type-Options: nosniff' \
  "nginx audio response lost centralized security headers"
assert_file_contains "$temporary_dir/audio-head.headers" \
  'Content-Security-Policy-Report-Only:' \
  "nginx audio response lost the report-only CSP header"
audio_size=$(awk 'tolower($1) == "content-length:" { sub(/\r$/, "", $2); print $2; exit }' \
  "$temporary_dir/audio-head.headers")
if [ -z "$audio_size" ] || [ "$audio_size" -le 16 ]; then
  fail "nginx audio Content-Length is missing or invalid"
fi

status=$(curl --silent --show-error --insecure --max-time 10 \
  --range 0-15 --dump-header "$temporary_dir/audio-bounded.headers" \
  --output /dev/null --write-out '%{http_code}' \
  "$audio_url")
assert_status 206 "$status" "nginx audio range response"
assert_file_contains "$temporary_dir/audio-bounded.headers" 'Content-Type: audio/mpeg' \
  "nginx MP3 content type is missing"
assert_file_contains "$temporary_dir/audio-bounded.headers" 'Accept-Ranges: bytes' \
  "nginx bounded range Accept-Ranges header is missing"
assert_file_contains "$temporary_dir/audio-bounded.headers" \
  "Content-Range: bytes 0-15/$audio_size" \
  "nginx bounded Content-Range is incorrect"
assert_file_contains "$temporary_dir/audio-bounded.headers" 'Content-Length: 16' \
  "nginx bounded Content-Length is incorrect"

open_length=$((audio_size - 16))
last_byte=$((audio_size - 1))
status=$(curl --silent --show-error --insecure --max-time 10 \
  --range 16- --dump-header "$temporary_dir/audio-open.headers" \
  --output /dev/null --write-out '%{http_code}' \
  "$audio_url")
assert_status 206 "$status" "nginx open-ended audio range response"
assert_file_contains "$temporary_dir/audio-open.headers" 'Accept-Ranges: bytes' \
  "nginx open-ended Accept-Ranges header is missing"
assert_file_contains "$temporary_dir/audio-open.headers" \
  "Content-Range: bytes 16-$last_byte/$audio_size" \
  "nginx open-ended Content-Range is incorrect"
assert_file_contains "$temporary_dir/audio-open.headers" "Content-Length: $open_length" \
  "nginx open-ended Content-Length is incorrect"

suffix_start=$((audio_size - 16))
status=$(curl --silent --show-error --insecure --max-time 10 \
  --range -16 --dump-header "$temporary_dir/audio-suffix.headers" \
  --output /dev/null --write-out '%{http_code}' \
  "$audio_url")
assert_status 206 "$status" "nginx suffix audio range response"
assert_file_contains "$temporary_dir/audio-suffix.headers" 'Accept-Ranges: bytes' \
  "nginx suffix Accept-Ranges header is missing"
assert_file_contains "$temporary_dir/audio-suffix.headers" \
  "Content-Range: bytes $suffix_start-$last_byte/$audio_size" \
  "nginx suffix Content-Range is incorrect"
assert_file_contains "$temporary_dir/audio-suffix.headers" 'Content-Length: 16' \
  "nginx suffix Content-Length is incorrect"

status=$(curl --silent --show-error --insecure --max-time 10 \
  --header "Range: bytes=$audio_size-" \
  --dump-header "$temporary_dir/audio-unsatisfiable.headers" \
  --output /dev/null --write-out '%{http_code}' \
  "$audio_url")
assert_status 416 "$status" "nginx unsatisfiable audio range response"
assert_file_contains "$temporary_dir/audio-unsatisfiable.headers" \
  "Content-Range: bytes */$audio_size" \
  "nginx unsatisfiable Content-Range is incorrect"

status=$(curl --silent --show-error --insecure --max-time 10 \
  --output /dev/null --write-out '%{http_code}' \
  "$base_url/katkida-bulunun")
assert_status 404 "$status" "retired contribution page"

status=$(curl --silent --show-error --insecure --max-time 10 \
  --request POST --output /dev/null --write-out '%{http_code}' \
  "$base_url/katkida-bulunun")
assert_status 405 "$status" "retired contribution endpoint"

docker compose -p "$project" -f "$compose_file" \
  logs --no-color nginx > "$temporary_dir/nginx.log"
if grep -E '"(GET|HEAD|POST) /' "$temporary_dir/nginx.log" >/dev/null; then
  fail "nginx emitted an access log record"
fi

run_enforced_csp_acceptance() {
  variant=$1
  export GALATA_PREVIEW_CSP_VARIANT="$variant"
  export GALATA_PREVIEW_ENFORCE_CSP=1

  docker compose -p "$project" -f "$compose_file" build nginx
  docker compose -p "$project" -f "$compose_file" \
    up --detach --no-deps --force-recreate nginx

  ready=false
  attempt=1
  while [ "$attempt" -le 60 ]; do
    if curl --silent --show-error --insecure --fail --max-time 3 \
      "$base_url/healthz" >/dev/null 2>&1
    then
      ready=true
      break
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  if [ "$ready" != true ]; then
    fail "$variant enforced CSP endpoint did not become healthy"
  fi

  curl --silent --show-error --insecure --max-time 10 \
    --dump-header "$temporary_dir/$variant-enforced.headers" \
    --output /dev/null \
    "$base_url/"
  expected_csp=$(sed -n \
    's/^add_header Content-Security-Policy-Report-Only "\(.*\)" always;$/\1/p' \
    "$repo_root/ops/nginx/galata-$variant-csp.conf")
  actual_csp=$(awk '
    tolower($1) == "content-security-policy:" {
      sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit
    }
  ' "$temporary_dir/$variant-enforced.headers")
  if [ -z "$expected_csp" ] || [ "$actual_csp" != "$expected_csp" ]; then
    fail "$variant enforced CSP header does not match its deployed policy"
  fi
  if grep -i '^Content-Security-Policy-Report-Only:' \
    "$temporary_dir/$variant-enforced.headers" >/dev/null
  then
    fail "$variant test image retained the report-only CSP header"
  fi

  if ! docker compose --profile csp -p "$project" -f "$compose_file" \
    run --rm --no-deps browser
  then
    fail "$variant enforced CSP browser acceptance"
  fi
}

docker compose --profile csp -p "$project" -f "$compose_file" build browser
run_enforced_csp_acceptance production
run_enforced_csp_acceptance dev

echo "Production preview and enforced CSP browser acceptance passed at $base_url."
