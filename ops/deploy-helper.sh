#!/bin/sh
set -eu

PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

DEPLOY_ROOT=/var/lib/galata-deploy
PROCESS_ROOT=/var/lib/galata-deploy-processing
CODE_RELEASES=/opt/galata/releases
MEDIA_RELEASES=/var/www/galata-media/releases
LOCK_FILE=/run/lock/galata-deploy.lock

die() { printf 'galata-deploy-helper: %s\n' "$*" >&2; exit 1; }
note() { printf 'galata-deploy-helper: %s\n' "$*"; }
require_root() { [ "$(id -u)" -eq 0 ] || die "must run as root"; }
valid_slot() { case "$1" in dev|production) ;; *) die "invalid slot: $1" ;; esac; }
valid_release_id() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{12}-[0-9a-f]{16}$' || die "unsafe release id"; }
valid_commit() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$' || die "invalid commit"; }
valid_hash() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{64}$' || die "invalid SHA-256"; }

slot_values() {
  valid_slot "$1"
  if [ "$1" = production ]; then
    SERVICE=galata-server.service
    RUNTIME_USER=galata
    ENV_FILE=/etc/galata/production.env
    CURRENT_LINK=/opt/galata/current
    MEDIA_LINK=/var/www/galatadergisi.org/public
    CONTRIBUTIONS=/var/lib/galata-contributions
    PORT=3000
    CANDIDATE_PORT=39000
    HOSTNAME=galatadergisi.org
  else
    SERVICE=galata-dev-server.service
    RUNTIME_USER=galata-dev
    ENV_FILE=/etc/galata/dev.env
    CURRENT_LINK=/opt/galata/current-dev
    MEDIA_LINK=/var/www/dev.galatadergisi.org/public
    CONTRIBUTIONS=/var/lib/galata-dev-contributions
    PORT=3001
    CANDIDATE_PORT=39001
    HOSTNAME=dev.galatadergisi.org
  fi
  HISTORY="$DEPLOY_ROOT/history/$1"
}

manifest_value() {
  key=$1
  file=$2
  count=$(grep -c "^${key}=" "$file" || true)
  [ "$count" -eq 1 ] || die "manifest must contain exactly one $key"
  sed -n "s/^${key}=//p" "$file"
}

validate_manifest() {
  manifest=$1
  [ -f "$manifest" ] && [ ! -L "$manifest" ] || die "release manifest is not a regular file"
  [ "$(wc -l < "$manifest" | tr -d ' ')" -eq 9 ] || die "release manifest must have exactly nine fields"
  [ "$(manifest_value format "$manifest")" = 1 ] || die "unsupported manifest format"
  MANIFEST_RELEASE=$(manifest_value release_id "$manifest")
  APP_COMMIT=$(manifest_value application_commit "$manifest")
  STATIC_COMMIT=$(manifest_value static_assets_commit "$manifest")
  SITE_RELEASE=$(manifest_value embedded_site_release "$manifest")
  ARCHITECTURES=$(manifest_value architectures "$manifest")
  AMD64_HASH=$(manifest_value binary_amd64_sha256 "$manifest")
  ARM64_HASH=$(manifest_value binary_arm64_sha256 "$manifest")
  MEDIA_HASH=$(manifest_value media_inventory_sha256 "$manifest")
  valid_release_id "$MANIFEST_RELEASE"
  valid_commit "$APP_COMMIT"; valid_commit "$STATIC_COMMIT"
  printf '%s' "$SITE_RELEASE" | grep -Eq '^[0-9a-f]{16}$' || die "invalid embedded release"
  [ "$ARCHITECTURES" = amd64,arm64 ] || die "unsupported architecture inventory"
  valid_hash "$AMD64_HASH"; valid_hash "$ARM64_HASH"; valid_hash "$MEDIA_HASH"
  [ "$MANIFEST_RELEASE" = "$(printf '%.12s-%s' "$APP_COMMIT" "$SITE_RELEASE")" ] \
    || die "release id does not match provenance"
}

validate_media_inventory() {
  inventory=$1
  media_source=$2
  [ -s "$inventory" ] && [ ! -L "$inventory" ] || die "media inventory is missing"
  if find "$media_source" -mindepth 1 -maxdepth 1 ! -name images ! -name audio -print -quit | grep -q .; then
    die "media staging contains an unexpected root"
  fi
  [ "$(sha256sum "$inventory" | awk '{print $1}')" = "$MEDIA_HASH" ] \
    || die "media inventory checksum mismatch"
  sed 's/^[0-9a-f][0-9a-f]*  //' "$inventory" | LC_ALL=C sort -c \
    || die "media inventory paths are not sorted"
  while IFS= read -r line; do
    printf '%s\n' "$line" | grep -Eq '^[0-9a-f]{64}  (images|audio)/[^/].*$' \
      || die "malformed media inventory entry"
    path=${line#*  }
    case "/$path/" in *'/../'*|*'/./'*|*'//'*) die "unsafe media path: $path" ;; esac
    [ -f "$media_source/$path" ] && [ ! -L "$media_source/$path" ] \
      || die "media path is missing or unsafe: $path"
  done < "$inventory"
  (cd "$media_source" && sha256sum -c "$inventory") >/dev/null \
    || die "media content checksum mismatch"
  actual_paths=$(mktemp /run/galata-media-paths.XXXXXX)
  listed_paths=$(mktemp /run/galata-inventory-paths.XXXXXX)
  (cd "$media_source" && find images audio -type f -print | LC_ALL=C sort) > "$actual_paths"
  sed 's/^[0-9a-f][0-9a-f]*  //' "$inventory" > "$listed_paths"
  if ! cmp -s "$actual_paths" "$listed_paths"; then
    rm -f "$actual_paths" "$listed_paths"
    die "media inventory and deployed file set differ"
  fi
  rm -f "$actual_paths" "$listed_paths"
  if find "$media_source/images" "$media_source/audio" \
      \( -type l -o \( ! -type d ! -type f \) \) -print -quit | grep -q .; then
    die "media cache contains a symlink or special file"
  fi
}

publish_media_permissions() {
  media_source=$1
  chown -R root:root "$media_source"
  find "$media_source" -type d -exec chmod 0555 {} +
  find "$media_source" -type f -exec chmod 0444 {} +
}

validate_published_media_permissions() {
  media_source=$1
  if find "$media_source" -type d \
      \( ! -user root -o ! -group root -o ! -perm 0555 \) -print -quit | grep -q .; then
    die "published media directories are not immutable and web-readable"
  fi
  if find "$media_source" -type f \
      \( ! -user root -o ! -group root -o ! -perm 0444 \) -print -quit | grep -q .; then
    die "published media files are not immutable and web-readable"
  fi
}

atomic_link() {
  target=$1
  link=$2
  temporary="${link}.new.$$"
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" "$link"
}

health_release() {
  port=$1
  expected=$2
  attempts=0
  while [ "$attempts" -lt 30 ]; do
    response=$(curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:$port/healthz" 2>/dev/null || true)
    printf '%s' "$response" | grep -Fq "\"release\":\"$expected\"" && return 0
    attempts=$((attempts + 1))
    sleep 1
  done
  return 1
}

candidate_check() {
  binary=$1
  expected=$2
  unit="galata-candidate-$RUNTIME_USER-$$"
  systemd-run --quiet --unit "$unit" \
    --property="User=$RUNTIME_USER" --property="Group=$RUNTIME_USER" \
    --property="EnvironmentFile=$ENV_FILE" \
    --property=UMask=0077 --property=CapabilityBoundingSet= --property=AmbientCapabilities= \
    --property=NoNewPrivileges=yes --property=PrivateTmp=yes --property=PrivateDevices=yes \
    --property=ProtectSystem=strict --property=ProtectHome=yes \
    --property=ProtectKernelTunables=yes --property=ProtectKernelModules=yes \
    --property=ProtectKernelLogs=yes --property=ProtectControlGroups=yes \
    --property=ProtectClock=yes --property=ProtectHostname=yes \
    --property=ProtectProc=invisible --property=ProcSubset=pid \
    --property=RestrictSUIDSGID=yes --property=RestrictNamespaces=yes \
    --property=LockPersonality=yes --property=MemoryDenyWriteExecute=yes \
    --property=SystemCallArchitectures=native \
    --property='RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' \
    --property="ReadWritePaths=$CONTRIBUTIONS" \
    /usr/bin/env "LISTEN_ADDR=127.0.0.1:$CANDIDATE_PORT" "$binary"
  if ! health_release "$CANDIDATE_PORT" "$expected"; then
    systemctl stop "$unit.service" >/dev/null 2>&1 || true
    systemctl reset-failed "$unit.service" >/dev/null 2>&1 || true
    die "candidate health check failed"
  fi
  systemctl stop "$unit.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$unit.service" >/dev/null 2>&1 || true
}

origin_check() {
  expected=$1
  health_release "$PORT" "$expected" || return 1
  nginx -t >/dev/null 2>&1 || return 1
  if [ -L "/etc/nginx/sites-enabled/$HOSTNAME.conf" ]; then
    response=$(curl --fail --silent --show-error --max-time 5 \
      --header "Host: $HOSTNAME" "http://127.0.0.1:8080/healthz" 2>/dev/null || true)
    printf '%s' "$response" | grep -Fq "\"release\":\"$expected\"" || return 1
  fi
}

tunnel_connected() {
  curl --fail --silent --show-error --max-time 2 \
    http://127.0.0.1:20241/metrics 2>/dev/null | awk '
      $1 ~ /^cloudflared_tunnel_ha_connections(\{.*\})?$/ { total += $2 }
      END { exit total >= 1 ? 0 : 1 }
    '
}

record_deployment() {
  slot=$1; release=$2; media=$3
  mkdir -p "$HISTORY"
  record=$(mktemp "$HISTORY/$(date -u +%Y%m%dT%H%M%SZ)-$release.XXXXXX")
  printf 'release_id=%s\nmedia_id=%s\n' "$release" "$media" > "$record"
  chmod 0644 "$record"
  ls -1t "$HISTORY" | sed -n '6,$p' | while IFS= read -r old; do rm -f "$HISTORY/$old"; done
  cleanup_unreferenced
}

cleanup_unreferenced() {
  protected_code=$(mktemp /run/galata-code.XXXXXX)
  protected_media=$(mktemp /run/galata-media.XXXXXX)
  for link in /opt/galata/current /opt/galata/current-dev; do
    [ -L "$link" ] && basename "$(readlink -f "$link")" >> "$protected_code"
  done
  for link in /var/www/galatadergisi.org/public /var/www/dev.galatadergisi.org/public; do
    [ -L "$link" ] && basename "$(readlink -f "$link")" >> "$protected_media"
  done
  find "$DEPLOY_ROOT/history" -mindepth 2 -maxdepth 2 -type f -print | while IFS= read -r record; do
    sed -n 's/^release_id=//p' "$record" >> "$protected_code"
    sed -n 's/^media_id=//p' "$record" >> "$protected_media"
  done
  find "$CODE_RELEASES" -mindepth 1 -maxdepth 1 -type d -print | while IFS= read -r directory; do
    grep -Fxq "$(basename "$directory")" "$protected_code" || rm -rf "$directory"
  done
  find "$MEDIA_RELEASES" -mindepth 1 -maxdepth 1 -type d ! -name '.new-*' -print | while IFS= read -r directory; do
    grep -Fxq "$(basename "$directory")" "$protected_media" || rm -rf "$directory"
  done
  rm -f "$protected_code" "$protected_media"
}

restore_pair() {
  old_code=$1; old_media=$2
  if [ -n "$old_code" ]; then atomic_link "$old_code" "$CURRENT_LINK"; else rm -f "$CURRENT_LINK"; fi
  if [ -n "$old_media" ]; then atomic_link "$old_media" "$MEDIA_LINK"; else rm -f "$MEDIA_LINK"; fi
  if [ -n "$old_code" ]; then
    systemctl restart "$SERVICE" || true
  else
    systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
  fi
}

activate_pair() {
  release=$1; media=$2; expected=$3; should_record=$4
  code_dir="$CODE_RELEASES/$release"
  media_dir="$MEDIA_RELEASES/$media"
  [ -x "$code_dir/galata-server" ] || die "installed code release does not exist"
  [ -d "$media_dir" ] || die "installed media release does not exist"
  candidate_check "$code_dir/galata-server" "$expected"
  old_code=$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)
  old_media=$(readlink -f "$MEDIA_LINK" 2>/dev/null || true)
  atomic_link "$code_dir" "$CURRENT_LINK"
  atomic_link "$media_dir" "$MEDIA_LINK"
  if ! systemctl enable --now "$SERVICE" >/dev/null || ! systemctl restart "$SERVICE" \
      || ! origin_check "$expected"; then
    restore_pair "$old_code" "$old_media"
    die "activation failed; previous code and media were restored"
  fi
  [ "$should_record" = yes ] && record_deployment "$SLOT" "$release" "$media"
}

configure() {
  [ "${SUDO_USER:-root}" != galata-deploy ] || die "deployment identity cannot configure the host"
  bundle=$1
  for file in deploy-key.pub production.env dev.env galata-shared.conf \
      galatadergisi.org.conf dev.galatadergisi.org.conf \
      galata-server.service galata-dev-server.service cloudflared.service; do
    [ -f "$bundle/$file" ] && [ ! -L "$bundle/$file" ] || die "configuration bundle lacks $file"
  done
  getent group sshlogin >/dev/null || die "Phase 1 sshlogin group is missing"
  id galata >/dev/null 2>&1 || die "Phase 1 galata user is missing"
  command -v cloudflared >/dev/null 2>&1 || die "Phase 1 cloudflared package is missing"
  ufw status | grep -q '^Status: active$' || die "Phase 1 UFW policy is not active"
  if ufw status | grep -Eq '^[[:space:]]*(80|443|8080|3000|3001)(/tcp)?[[:space:]]+ALLOW'; then
    die "a web or application port is publicly allowed by UFW"
  fi
  find /etc/nginx/sites-enabled -mindepth 1 -maxdepth 1 -print | while IFS= read -r site; do
    case "$(basename "$site")" in
      galatadergisi.org.conf|dev.galatadergisi.org.conf) ;;
      *) die "unexpected enabled nginx site: $site" ;;
    esac
  done
  id galata-dev >/dev/null 2>&1 || useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin galata-dev
  id galata-deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash galata-deploy
  passwd -l galata-dev >/dev/null; passwd -l galata-deploy >/dev/null
  usermod -G sshlogin galata-deploy

  install -d -m 0755 -o root -g root /home/galata-deploy
  install -d -m 0750 -o root -g galata-deploy /home/galata-deploy/.ssh
  { printf 'restrict '; cat "$bundle/deploy-key.pub"; } > /home/galata-deploy/.ssh/authorized_keys
  chown root:galata-deploy /home/galata-deploy/.ssh/authorized_keys
  chmod 0640 /home/galata-deploy/.ssh/authorized_keys
  printf '%s\n' 'galata-deploy ALL=(root) NOPASSWD: /usr/local/sbin/galata-deploy-helper *' \
    > /etc/sudoers.d/galata-deploy
  chmod 0440 /etc/sudoers.d/galata-deploy
  visudo -cf /etc/sudoers.d/galata-deploy >/dev/null

  install -d -m 0755 -o root -g root "$CODE_RELEASES" "$MEDIA_RELEASES" /var/www/galata-media
  install -d -m 0755 -o root -g root "$DEPLOY_ROOT"
  install -d -m 0750 -o galata-deploy -g galata-deploy "$DEPLOY_ROOT/incoming" "$DEPLOY_ROOT/media-cache"
  install -d -m 0755 -o root -g root "$DEPLOY_ROOT/history"
  install -d -m 0700 -o root -g root "$PROCESS_ROOT"
  install -d -m 0750 -o root -g www-data /var/www/galatadergisi.org /var/www/dev.galatadergisi.org
  install -d -m 0700 -o galata -g galata /var/lib/galata-contributions
  install -d -m 0700 -o galata-dev -g galata-dev /var/lib/galata-dev-contributions
  install -d -m 0755 -o root -g root /etc/nginx/sites-available \
    /var/log/nginx/galatadergisi.org /var/log/nginx/dev.galatadergisi.org
  install -m 0600 -o root -g root "$bundle/production.env" /etc/galata/production.env
  install -m 0600 -o root -g root "$bundle/dev.env" /etc/galata/dev.env
  install -m 0644 -o root -g root "$bundle/galata-shared.conf" /etc/nginx/conf.d/galata-shared.conf
  install -m 0644 -o root -g root "$bundle/galatadergisi.org.conf" /etc/nginx/sites-available/galatadergisi.org.conf
  install -m 0644 -o root -g root "$bundle/dev.galatadergisi.org.conf" /etc/nginx/sites-available/dev.galatadergisi.org.conf
  install -m 0644 -o root -g root "$bundle/galata-server.service" /etc/systemd/system/galata-server.service
  install -m 0644 -o root -g root "$bundle/galata-dev-server.service" /etc/systemd/system/galata-dev-server.service
  install -m 0644 -o root -g root "$bundle/cloudflared.service" /etc/systemd/system/cloudflared.service
  ln -sfn /etc/nginx/sites-available/galatadergisi.org.conf \
    /etc/nginx/sites-enabled/galatadergisi.org.conf
  ln -sfn /etc/nginx/sites-available/dev.galatadergisi.org.conf \
    /etc/nginx/sites-enabled/dev.galatadergisi.org.conf
  systemctl daemon-reload
  systemd-analyze verify /etc/systemd/system/galata-server.service \
    /etc/systemd/system/galata-dev-server.service \
    /etc/systemd/system/cloudflared.service >/dev/null
  nginx -t >/dev/null
  systemctl reload nginx.service
  runuser -u galata-deploy -- test ! -r /etc/galata/production.env || die "deploy user can read runtime secrets"
  runuser -u galata-deploy -- test ! -r /etc/cloudflared/tunnel-token || die "deploy user can read the tunnel token"
  runuser -u galata-deploy -- test ! -r /var/lib/galata-contributions || die "deploy user can read production contributions"
  runuser -u galata-deploy -- test ! -r /var/lib/galata-dev-contributions || die "deploy user can read dev contributions"
  runuser -u galata-deploy -- test -r /home/galata-deploy/.ssh/authorized_keys \
    || die "deploy user cannot read SSH authorization"
  runuser -u galata-deploy -- test ! -w /home/galata-deploy/.ssh/authorized_keys \
    || die "deploy user can alter SSH authorization"
  runuser -u galata-deploy -- test ! -w /home/galata-deploy || die "deploy user can alter SSH authorization"
  note "deployment foundation configured; loopback nginx sites are enabled and dev requires Cloudflare Access"
}

install_release() {
  release=$1
  staged="$DEPLOY_ROOT/incoming/$release-$SLOT"
  [ -d "$staged" ] && [ ! -L "$staged" ] || die "staged release is missing or unsafe"
  incoming="$PROCESS_ROOT/$release-$SLOT-$$"
  mv "$staged" "$incoming"
  PROCESSING_DIR=$incoming
  trap 'rm -rf "${PROCESSING_DIR:-}"' EXIT HUP INT TERM
  if find "$incoming" \( -type l -o \( ! -type d ! -type f \) \) -print -quit | grep -q .; then
    die "staged release contains a symlink or special file"
  fi
  incoming_entries=$(find "$incoming" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')
  [ "$incoming_entries" -eq 4 ] || die "staged release contains unexpected top-level content"
  for required in RELEASE-MANIFEST MEDIA-SHA256SUMS galata-server media; do
    [ -e "$incoming/$required" ] || die "staged release lacks $required"
  done
  find "$incoming" -type d -exec chown root:root {} + -exec chmod 0700 {} +
  find "$incoming" -type f -exec chown root:root {} + -exec chmod 0600 {} +
  validate_manifest "$incoming/RELEASE-MANIFEST"
  [ "$MANIFEST_RELEASE" = "$release" ] || die "staging directory and manifest disagree"
  architecture=$(dpkg --print-architecture)
  case "$architecture" in amd64) expected_hash=$AMD64_HASH ;; arm64) expected_hash=$ARM64_HASH ;; *) die "unsupported VPS architecture" ;; esac
  [ -f "$incoming/galata-server" ] && [ ! -L "$incoming/galata-server" ] || die "candidate binary is unsafe"
  [ "$(sha256sum "$incoming/galata-server" | awk '{print $1}')" = "$expected_hash" ] || die "binary checksum mismatch"
  validate_media_inventory "$incoming/MEDIA-SHA256SUMS" "$incoming/media"
  code_dir="$CODE_RELEASES/$release"
  if [ ! -d "$code_dir" ]; then
    install -d -m 0755 -o root -g root "$code_dir"
    install -m 0755 -o root -g root "$incoming/galata-server" "$code_dir/galata-server"
    install -m 0644 -o root -g root "$incoming/RELEASE-MANIFEST" "$incoming/MEDIA-SHA256SUMS" "$code_dir/"
  fi
  [ "$(sha256sum "$code_dir/galata-server" | awk '{print $1}')" = "$expected_hash" ] \
    || die "installed binary checksum mismatch"
  media_dir="$MEDIA_RELEASES/$STATIC_COMMIT"
  if [ ! -d "$media_dir" ]; then
    temporary="$MEDIA_RELEASES/.new-$STATIC_COMMIT-$$"
    previous=$(find "$MEDIA_RELEASES" -mindepth 1 -maxdepth 1 -type d ! -name '.new-*' | head -1 || true)
    if [ -n "$previous" ]; then
      rsync -a --delete --link-dest="$previous" "$incoming/media/" "$temporary/"
    else
      rsync -a --delete "$incoming/media/" "$temporary/"
    fi
    publish_media_permissions "$temporary"
    mv "$temporary" "$media_dir"
  fi
  # Also migrate releases created by older helpers, which removed write bits
  # from the private staging modes and accidentally left nginx unable to
  # traverse directories or read files.
  publish_media_permissions "$media_dir"
  validate_published_media_permissions "$media_dir"
  validate_media_inventory "$incoming/MEDIA-SHA256SUMS" "$media_dir"
  old_cache="$DEPLOY_ROOT/.media-cache-old-$$"
  mv "$DEPLOY_ROOT/media-cache" "$old_cache"
  mv "$incoming/media" "$DEPLOY_ROOT/media-cache"
  chown -R galata-deploy:galata-deploy "$DEPLOY_ROOT/media-cache"
  chmod -R u+rwX,go-rwx "$DEPLOY_ROOT/media-cache"
  rm -rf "$old_cache"
  INSTALLED_RELEASE=$release
  INSTALLED_MEDIA=$STATIC_COMMIT
  INSTALLED_SITE_RELEASE=$SITE_RELEASE
}

activate() {
  SLOT=$1; slot_values "$SLOT"
  release=$2; valid_release_id "$release"
  install_release "$release"
  activate_pair "$INSTALLED_RELEASE" "$INSTALLED_MEDIA" "$INSTALLED_SITE_RELEASE" yes
  rm -rf "$PROCESSING_DIR"
  PROCESSING_DIR=
  trap - EXIT HUP INT TERM
  note "$SLOT activated release $release with media $INSTALLED_MEDIA"
}

rollback() {
  SLOT=$1; slot_values "$SLOT"
  requested=${2:-}
  [ -d "$HISTORY" ] || die "no $SLOT deployment history"
  if [ -n "$requested" ]; then
    valid_release_id "$requested"
    record=$(grep -l "^release_id=$requested$" "$HISTORY"/* 2>/dev/null | tail -1 || true)
  else
    record=$(ls -1t "$HISTORY" | sed -n '2p')
    [ -n "$record" ] && record="$HISTORY/$record"
  fi
  [ -n "$record" ] && [ -f "$record" ] || die "rollback release is not in retained $SLOT history"
  release=$(sed -n 's/^release_id=//p' "$record")
  media=$(sed -n 's/^media_id=//p' "$record")
  validate_manifest "$CODE_RELEASES/$release/RELEASE-MANIFEST"
  activate_pair "$release" "$media" "$SITE_RELEASE" yes
  note "$SLOT rolled back to $release"
}

verify() {
  SLOT=$1; slot_values "$SLOT"
  [ -L "$CURRENT_LINK" ] && [ -L "$MEDIA_LINK" ] || die "$SLOT is not deployed"
  release=$(basename "$(readlink -f "$CURRENT_LINK")")
  validate_manifest "$CODE_RELEASES/$release/RELEASE-MANIFEST"
  architecture=$(dpkg --print-architecture)
  case "$architecture" in amd64) expected_hash=$AMD64_HASH ;; arm64) expected_hash=$ARM64_HASH ;; *) die "unsupported VPS architecture" ;; esac
  [ "$(sha256sum "$CODE_RELEASES/$release/galata-server" | awk '{print $1}')" = "$expected_hash" ] \
    || die "$SLOT installed binary checksum mismatch"
  active_media=$(readlink -f "$MEDIA_LINK")
  validate_published_media_permissions "$active_media"
  validate_media_inventory "$CODE_RELEASES/$release/MEDIA-SHA256SUMS" "$active_media"
  [ "$(stat -c '%U:%G %a' "$ENV_FILE")" = 'root:root 600' ] || die "$SLOT environment permissions are unsafe"
  [ "$(stat -c '%U:%G %a' "$CONTRIBUTIONS")" = "$RUNTIME_USER:$RUNTIME_USER 700" ] \
    || die "$SLOT contribution permissions are unsafe"
  systemctl is-enabled --quiet "$SERVICE" && systemctl is-active --quiet "$SERVICE" \
    || die "$SERVICE is not enabled and active"
  systemd-analyze verify "/etc/systemd/system/$SERVICE" >/dev/null
  origin_check "$SITE_RELEASE" || die "$SLOT origin verification failed"
  ufw status | grep -q '^Status: active$' || die "UFW is inactive"
  if ufw status | grep -Eq '^[[:space:]]*(80|443|8080|3000|3001)(/tcp)?[[:space:]]+ALLOW'; then
    die "a web or application port is publicly allowed by UFW"
  fi
  for check_port in 3000 3001 8080 20241; do
    listeners=$(ss -H -ltn "sport = :$check_port" | awk '{print $4}')
    if printf '%s\n' "$listeners" | grep -Ev '^$|^(127\.0\.0\.1|\[::1\]):' | grep -q .; then
      die "application port $check_port has a non-loopback listener"
    fi
  done
  listeners=$(ss -H -ltn "sport = :$PORT" | awk '{print $4}')
  [ -n "$listeners" ] || die "$SLOT application port is not listening"
  listeners=$(ss -H -ltn 'sport = :8080' | awk '{print $4}')
  printf '%s\n' "$listeners" | grep -qx '127.0.0.1:8080' \
    || die "nginx tunnel origin is not listening on 127.0.0.1:8080"
  [ "$(stat -c '%U:%G %a' /etc/cloudflared/tunnel-token)" = 'root:root 600' ] \
    || die "Cloudflare Tunnel token permissions are unsafe"
  systemctl is-enabled --quiet cloudflared.service \
    && systemctl is-active --quiet cloudflared.service \
    || die "cloudflared.service is not enabled and active"
  tunnel_connected || die "Cloudflare Tunnel has no active connections"
  runuser -u galata-deploy -- test ! -r /etc/galata/production.env || die "deploy user can read runtime secrets"
  runuser -u galata-deploy -- test ! -r /etc/cloudflared/tunnel-token || die "deploy user can read the tunnel token"
  runuser -u galata-deploy -- test ! -r /var/lib/galata-contributions || die "deploy user can read production contributions"
  runuser -u galata-deploy -- test ! -r /var/lib/galata-dev-contributions || die "deploy user can read dev contributions"
  runuser -u galata-deploy -- test ! -w /home/galata-deploy || die "deploy user can alter SSH authorization"
  note "$SLOT verified release=$release media=$(basename "$(readlink -f "$MEDIA_LINK")")"
}

status() {
  cache_bytes=$(du -sb "$DEPLOY_ROOT/media-cache" 2>/dev/null | awk '{print $1}' || printf 0)
  printf 'architecture=%s\ncache_bytes=%s\n' "$(dpkg --print-architecture)" "$cache_bytes"
}

require_root
command=${1:-}
[ -n "$command" ] || die "command required"
shift
case "$command" in
  configure) [ "$#" -eq 1 ] || die "configure requires bundle path"; configure "$1" ;;
  status) [ "$#" -eq 0 ] || die "status takes no arguments"; status ;;
  activate|rollback)
    [ "${SUDO_USER:-}" = galata-deploy ] || [ "${SUDO_USER:-root}" != galata-deploy ]
    exec 9>"$LOCK_FILE"; flock -n 9 || die "another deployment is running"
    if [ "$command" = activate ]; then [ "$#" -eq 2 ] || die "activate requires slot and release"; activate "$1" "$2"
    else [ "$#" -ge 1 ] && [ "$#" -le 2 ] || die "rollback requires slot and optional release"; rollback "$@"; fi
    ;;
  verify) [ "$#" -eq 1 ] || die "verify requires slot"; verify "$1" ;;
  *) die "unsupported command: $command" ;;
esac
