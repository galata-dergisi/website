#!/bin/sh
set -eu

app_commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
static_commit=cccccccccccccccccccccccccccccccccccccccc
site_release=bbbbbbbbbbbbbbbb
release_id=aaaaaaaaaaaa-bbbbbbbbbbbbbbbb
fixture=/usr/local/libexec/galata-deploy-health-server
. /usr/local/libexec/galata-runtime-environment.sh

fail() {
  printf 'deploy environment test: %s\n' "$*" >&2
  exit 1
}

stage_release() {
  slot=$1
  staged="/var/lib/galata-deploy/incoming/$release_id-$slot"
  install -d -m 0750 "$staged/media/images" "$staged/media/audio"
  printf 'fixture media\n' > "$staged/media/images/fixture.txt"
  printf 'fixture audio\n' > "$staged/media/audio/fixture.mp3"
  (
    cd "$staged/media"
    sha256sum audio/fixture.mp3 images/fixture.txt > ../MEDIA-SHA256SUMS
  )
  install -m 0755 "$fixture" "$staged/galata-server"
  binary_hash=$(sha256sum "$staged/galata-server" | awk '{print $1}')
  inventory_hash=$(sha256sum "$staged/MEDIA-SHA256SUMS" | awk '{print $1}')
  {
    printf 'format=1\n'
    printf 'release_id=%s\n' "$release_id"
    printf 'application_commit=%s\n' "$app_commit"
    printf 'static_assets_commit=%s\n' "$static_commit"
    printf 'embedded_site_release=%s\n' "$site_release"
    printf 'architectures=amd64,arm64\n'
    printf 'binary_amd64_sha256=%s\n' "$binary_hash"
    printf 'binary_arm64_sha256=%s\n' "$binary_hash"
    printf 'media_inventory_sha256=%s\n' "$inventory_hash"
  } > "$staged/RELEASE-MANIFEST"
}

assert_media_publication() {
  public_link=$1
  media_root=$(readlink -f "$public_link")
  [ "$(stat -c '%a %U:%G' "$media_root")" = '555 root:root' ] \
    || fail "published media root has unsafe or unreadable permissions"
  [ "$(stat -c '%a %U:%G' "$media_root/images/fixture.txt")" = '444 root:root' ] \
    || fail "published image has unsafe or unreadable permissions"
  [ "$(stat -c '%a %U:%G' "$media_root/audio/fixture.mp3")" = '444 root:root' ] \
    || fail "published audio has unsafe or unreadable permissions"
  runuser -u www-data -- test -r "$media_root/images/fixture.txt" \
    || fail "nginx user cannot read published images"
  runuser -u www-data -- test -r "$media_root/audio/fixture.mp3" \
    || fail "nginx user cannot read published audio"
}

id galata >/dev/null 2>&1 \
  || useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin galata
id galata-dev >/dev/null 2>&1 \
  || useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin galata-dev
id galata-deploy >/dev/null 2>&1 \
  || useradd --create-home --shell /bin/bash galata-deploy

install -d -m 0755 \
  /etc/galata \
  /opt/galata/releases \
  /var/lib/galata-deploy/incoming \
  /var/lib/galata-deploy/history \
  /var/lib/galata-deploy-processing \
  /var/www/galata-media/releases \
  /var/www/galatadergisi.org \
  /var/www/dev.galatadergisi.org
install -d -m 0750 -o galata-deploy -g galata-deploy \
  /var/lib/galata-deploy/incoming \
  /var/lib/galata-deploy/media-cache
write_runtime_environment production \
  > /etc/galata/production.env
write_runtime_environment dev \
  > /etc/galata/dev.env
chmod 0600 /etc/galata/production.env /etc/galata/dev.env
systemctl daemon-reload

stage_release production
SUDO_USER=galata-deploy /usr/local/sbin/galata-deploy-helper \
  activate production "$release_id"

stage_release dev
SUDO_USER=galata-deploy /usr/local/sbin/galata-deploy-helper \
  activate dev "$release_id"

assert_media_publication /var/www/galatadergisi.org/public
assert_media_publication /var/www/dev.galatadergisi.org/public

curl --fail --silent --show-error http://127.0.0.1:3000/healthz \
  | grep -Fq '"release":"bbbbbbbbbbbbbbbb"' \
  || fail "production service is unhealthy"
curl --fail --silent --show-error http://127.0.0.1:3001/healthz \
  | grep -Fq '"release":"bbbbbbbbbbbbbbbb"' \
  || fail "dev service is unhealthy"

printf 'deploy environment test: candidate isolation and media publication verified\n'
