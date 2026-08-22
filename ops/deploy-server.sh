#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
. "$SCRIPT_DIR/runtime-environment.sh"
ADMIN_TARGET=${GALATA_ADMIN_TARGET:-galata}
DEPLOY_KEY_PATH=${GALATA_DEPLOY_KEY_PATH:-${HOME}/.ssh/galata-deploy}
ADMIN_CONTROL_DIR=
ADMIN_CONTROL_PATH=
BUNDLE=
HOST_KEY_TEMP_DIR=

die() { printf 'deploy-server: %s\n' "$*" >&2; exit 1; }
note() { printf 'deploy-server: %s\n' "$*"; }

usage() {
  cat <<'EOF'
Usage:
  ./ops/deploy-server.sh configure
  ./ops/deploy-server.sh tunnel-setup [--rotate-token]
  ./ops/deploy-server.sh deploy <dev|production> --release-dir DIR --media-root DIR [--yes]
  ./ops/deploy-server.sh verify <dev|production> [--public]
  ./ops/deploy-server.sh rollback <dev|production> [release-id] [--yes]

Local operation uses the trusted SSH alias "galata". Set GALATA_DEPLOY_HOST,
GALATA_DEPLOY_PORT, GALATA_DEPLOY_SSH_KEY_PATH, and GALATA_SSH_KNOWN_HOSTS_FILE
in CI. Deploy and rollback require CLOUDFLARE_ZONE_ID and the dedicated
CLOUDFLARE_CACHE_PURGE_TOKEN. Secret-setup commands are deliberately
interactive and workstation-only.
EOF
}

valid_slot() { [[ ${1:-} == dev || ${1:-} == production ]] || die "slot must be dev or production"; }
valid_release_id() { [[ $1 =~ ^[0-9a-f]{12}-[0-9a-f]{16}$ ]] || die "unsafe release id: $1"; }
confirm() {
  [[ ${YES:-false} == true ]] && return
  [[ -t 0 ]] || die "confirmation requires a terminal; use --yes in automation"
  local answer
  read -r -p "$1 [y/N] " answer
  [[ $answer == y || $answer == Y ]] || die "cancelled"
}

read_secret() {
  local prompt=$1 first second
  [[ -t 0 ]] || die "$prompt requires a terminal"
  read -r -s -p "$prompt: " first; printf '\n' >&2
  [[ -n $first ]] || die "$prompt must not be empty"
  read -r -s -p "Confirm $prompt: " second; printf '\n' >&2
  [[ $first == "$second" ]] || die "$prompt values did not match"
  REPLY=$first
}

admin_ssh() {
  if [[ -n $ADMIN_CONTROL_PATH ]]; then
    ssh -o ControlMaster=auto -o "ControlPath=$ADMIN_CONTROL_PATH" -o ControlPersist=60 \
      "$ADMIN_TARGET" "$@"
  else
    ssh -o ControlMaster=no -o ControlPath=none -o ControlPersist=no "$ADMIN_TARGET" "$@"
  fi
}

admin_scp() {
  if [[ -n $ADMIN_CONTROL_PATH ]]; then
    scp -o ControlMaster=auto -o "ControlPath=$ADMIN_CONTROL_PATH" -o ControlPersist=60 "$@"
  else
    scp -o ControlMaster=no -o ControlPath=none -o ControlPersist=no "$@"
  fi
}

start_admin_control() {
  [[ -z $ADMIN_CONTROL_PATH ]] || return
  ADMIN_CONTROL_DIR=$(mktemp -d "${TMPDIR:-/tmp}/galata-admin-ssh.XXXXXX")
  chmod 0700 "$ADMIN_CONTROL_DIR"
  ADMIN_CONTROL_PATH="$ADMIN_CONTROL_DIR/socket"
}

stop_admin_control() {
  if [[ -n $ADMIN_CONTROL_PATH ]]; then
    if [[ -S $ADMIN_CONTROL_PATH ]]; then
      ssh -o "ControlPath=$ADMIN_CONTROL_PATH" -O exit "$ADMIN_TARGET" >/dev/null 2>&1 || true
    fi
    rm -rf "$ADMIN_CONTROL_DIR"
    ADMIN_CONTROL_DIR=
    ADMIN_CONTROL_PATH=
  fi
}

cleanup_local() {
  stop_admin_control
  if [[ -n $BUNDLE && -d $BUNDLE ]]; then rm -rf "$BUNDLE"; fi
  if [[ -n $HOST_KEY_TEMP_DIR && -d $HOST_KEY_TEMP_DIR ]]; then
    rm -rf "$HOST_KEY_TEMP_DIR"
  fi
}

trap cleanup_local EXIT

deploy_connection() {
  DEPLOY_SSH=(ssh -o ControlMaster=no -o ControlPath=none -o ControlPersist=no -o BatchMode=yes)
  DEPLOY_SCP=(scp -o ControlMaster=no -o ControlPath=none -o ControlPersist=no -o BatchMode=yes)
  if [[ -n ${GALATA_DEPLOY_HOST:-} ]]; then
    [[ -n ${GALATA_DEPLOY_PORT:-} && -n ${GALATA_DEPLOY_SSH_KEY_PATH:-} \
      && -n ${GALATA_SSH_KNOWN_HOSTS_FILE:-} ]] \
      || die "CI deployment connection variables are incomplete"
    [[ $GALATA_DEPLOY_HOST =~ ^[A-Za-z0-9.-]+$ ]] || die "invalid deployment host"
    [[ $GALATA_DEPLOY_PORT =~ ^[0-9]{1,5}$ ]] \
      && (( GALATA_DEPLOY_PORT >= 1 && GALATA_DEPLOY_PORT <= 65535 )) \
      || die "invalid deployment port"
    [[ -f $GALATA_DEPLOY_SSH_KEY_PATH && -f $GALATA_SSH_KNOWN_HOSTS_FILE ]] \
      || die "deployment key or known_hosts file is missing"
    DEPLOY_TARGET="galata-deploy@$GALATA_DEPLOY_HOST"
    DEPLOY_SSH+=( -F /dev/null -p "$GALATA_DEPLOY_PORT" -i "$GALATA_DEPLOY_SSH_KEY_PATH" \
      -o IdentitiesOnly=yes -o "UserKnownHostsFile=$GALATA_SSH_KNOWN_HOSTS_FILE" )
    DEPLOY_SCP+=( -F /dev/null -P "$GALATA_DEPLOY_PORT" -i "$GALATA_DEPLOY_SSH_KEY_PATH" \
      -o IdentitiesOnly=yes -o "UserKnownHostsFile=$GALATA_SSH_KNOWN_HOSTS_FILE" )
  else
    [[ -f $DEPLOY_KEY_PATH ]] || die "deployment key is missing; run configure first"
    DEPLOY_TARGET=${GALATA_DEPLOY_TARGET:-galata-deploy@galata}
    DEPLOY_SSH+=( -i "$DEPLOY_KEY_PATH" -o IdentitiesOnly=yes )
    DEPLOY_SCP+=( -i "$DEPLOY_KEY_PATH" -o IdentitiesOnly=yes )
  fi
}

deploy_ssh() { "${DEPLOY_SSH[@]}" "$DEPLOY_TARGET" "$@"; }

manifest_value() {
  local key=$1 file=$2 value count
  count=$(grep -c "^${key}=" "$file" || true)
  [[ $count == 1 ]] || die "manifest must contain exactly one $key"
  value=$(sed -n "s/^${key}=//p" "$file")
  printf '%s' "$value"
}

validate_local_release() {
  local release_dir=$1 media_root=$2 manifest="$release_dir/RELEASE-MANIFEST"
  local artifact name expected
  while IFS= read -r artifact; do
    [[ -f $artifact && ! -L $artifact ]] || die "release output contains a non-regular artifact"
    name=$(basename "$artifact")
    case $name in
      RELEASE-MANIFEST|MEDIA-SHA256SUMS|CACHE-PURGE-MANIFEST|SHA256SUMS|\
      galata-server-linux-amd64|galata-server-linux-arm64|\
      galata-server-linux-amd64.buildinfo|galata-server-linux-arm64.buildinfo) ;;
      *) die "unexpected release artifact: $name" ;;
    esac
  done < <(find "$release_dir" -mindepth 1 -maxdepth 1 -print)
  for name in RELEASE-MANIFEST MEDIA-SHA256SUMS CACHE-PURGE-MANIFEST SHA256SUMS \
      galata-server-linux-amd64 galata-server-linux-arm64; do
    [[ -f $release_dir/$name && ! -L $release_dir/$name ]] || die "release output lacks $name"
  done
  [[ $(wc -l < "$release_dir/SHA256SUMS" | tr -d ' ') == 5 ]] \
    || die "release checksum file must contain five entries"
  for name in galata-server-linux-amd64 galata-server-linux-arm64 \
      MEDIA-SHA256SUMS CACHE-PURGE-MANIFEST RELEASE-MANIFEST; do
    [[ $(grep -Ec "^[0-9a-f]{64}  ${name}$" "$release_dir/SHA256SUMS") == 1 ]] \
      || die "release checksum file lacks a strict $name entry"
  done
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$release_dir" && sha256sum -c SHA256SUMS >/dev/null) || die "release checksum file failed"
  else
    (cd "$release_dir" && shasum -a 256 -c SHA256SUMS >/dev/null) || die "release checksum file failed"
  fi
  [[ -f $manifest && ! -L $manifest ]] || die "RELEASE-MANIFEST is missing"
  [[ $(wc -l < "$manifest" | tr -d ' ') == 10 ]] || die "manifest must contain ten fields"
  [[ $(manifest_value format "$manifest") == 2 ]] || die "unsupported manifest format"
  RELEASE_ID=$(manifest_value release_id "$manifest"); valid_release_id "$RELEASE_ID"
  APP_COMMIT=$(manifest_value application_commit "$manifest")
  STATIC_COMMIT=$(manifest_value static_assets_commit "$manifest")
  SITE_RELEASE=$(manifest_value embedded_site_release "$manifest")
  [[ $APP_COMMIT =~ ^[0-9a-f]{40}$ && $STATIC_COMMIT =~ ^[0-9a-f]{40}$ \
    && $SITE_RELEASE =~ ^[0-9a-f]{16}$ ]] || die "manifest provenance is malformed"
  [[ $RELEASE_ID == "${APP_COMMIT:0:12}-$SITE_RELEASE" ]] \
    || die "release id does not match manifest provenance"
  [[ $(manifest_value architectures "$manifest") == amd64,arm64 ]] || die "manifest architecture list is invalid"
  for name in amd64 arm64; do
    expected=$(manifest_value "binary_${name}_sha256" "$manifest")
    [[ $expected =~ ^[0-9a-f]{64}$ ]] || die "manifest binary hash is invalid"
    [[ $(sha_local "$release_dir/galata-server-linux-$name") == "$expected" ]] \
      || die "manifest binary hash does not match $name"
  done
  MEDIA_INVENTORY_HASH=$(manifest_value media_inventory_sha256 "$manifest")
  [[ $MEDIA_INVENTORY_HASH =~ ^[0-9a-f]{64}$ ]] || die "media inventory hash is invalid"
  CACHE_PURGE_MANIFEST_HASH=$(manifest_value cache_purge_manifest_sha256 "$manifest")
  [[ $CACHE_PURGE_MANIFEST_HASH =~ ^[0-9a-f]{64}$ ]] || die "cache purge manifest hash is invalid"
  [[ -f $release_dir/MEDIA-SHA256SUMS && ! -L $release_dir/MEDIA-SHA256SUMS ]] || die "media inventory is missing"
  [[ -f $release_dir/CACHE-PURGE-MANIFEST && ! -L $release_dir/CACHE-PURGE-MANIFEST ]] \
    || die "cache purge manifest is missing"
  [[ -d $media_root/images && -d $media_root/audio ]] || die "media root must contain images/ and audio/"
  [[ $(git -C "$media_root" rev-parse HEAD) == "$STATIC_COMMIT" ]] || die "media checkout is not the manifest commit"
  [[ -z $(git -C "$media_root" status --porcelain --untracked-files=normal) ]] \
    || die "media checkout is dirty"
  if find "$media_root/images" "$media_root/audio" \( -type l -o \( ! -type d ! -type f \) \) -print -quit | grep -q .; then
    die "media contains a symlink or special file"
  fi
  local actual_media_hash
  actual_media_hash=$(sha_local "$release_dir/MEDIA-SHA256SUMS")
  [[ $actual_media_hash == "$MEDIA_INVENTORY_HASH" ]] || die "media inventory hash does not match the manifest"
  [[ $(sha_local "$release_dir/CACHE-PURGE-MANIFEST") == "$CACHE_PURGE_MANIFEST_HASH" ]] \
    || die "cache purge manifest hash does not match the release manifest"
  validate_cache_purge_manifest "$release_dir/CACHE-PURGE-MANIFEST"
  verify_media_inventory "$release_dir/MEDIA-SHA256SUMS" "$media_root"
}

validate_cache_purge_manifest() {
  local manifest=$1 line line_number=0 hash stable_path previous_path=
  [[ -f $manifest && ! -L $manifest ]] || die "cache purge manifest is not a regular file"
  while IFS= read -r line || [[ -n $line ]]; do
    line_number=$((line_number + 1))
    if (( line_number == 1 )); then
      [[ $line == format=1 ]] || die "unsupported cache purge manifest format"
      continue
    fi
    [[ $line =~ ^([0-9a-f]{64})\ \ (/[^[:space:]]*)$ ]] \
      || die "malformed cache purge manifest entry"
    hash=${BASH_REMATCH[1]}; stable_path=${BASH_REMATCH[2]}
    [[ $hash =~ ^[0-9a-f]{64}$ && $stable_path =~ ^/[A-Za-z0-9._~%/-]*$ ]] \
      || die "unsafe cache purge manifest entry"
    [[ $stable_path != *'//'* && $stable_path != *'/./'* && $stable_path != *'/../'* \
      && $stable_path != */. && $stable_path != */.. ]] \
      || die "unsafe cache purge path: $stable_path"
    [[ -z $previous_path || $stable_path > $previous_path ]] \
      || die "cache purge manifest paths must be sorted and unique"
    previous_path=$stable_path
  done < "$manifest"
  (( line_number >= 1 )) || die "cache purge manifest is empty"
}

require_cloudflare_cache_purge_config() {
  [[ ${CLOUDFLARE_ZONE_ID:-} =~ ^[A-Fa-f0-9]{32}$ ]] \
    || die "CLOUDFLARE_ZONE_ID must be a 32-character zone id"
  [[ ${CLOUDFLARE_CACHE_PURGE_TOKEN:-} =~ ^[A-Za-z0-9._-]+$ ]] \
    || die "CLOUDFLARE_CACHE_PURGE_TOKEN is missing or malformed"
}

require_cache_plan_capability() {
  local status=$1
  [[ $(sed -n 's/^cache_plan_format=//p' <<< "$status") == 2 ]] \
    || die "remote deployment helper lacks retry-safe cache planning; run deploy-server.sh configure"
}

purge_cloudflare_cache() {
  local slot=$1 activation_output=$2 marker_count release_count purge_release
  local line stable_path hostname previous_path= url offset index batch_end
  local -a paths=() hostnames=() urls=()
  local request_file response first
  marker_count=$(grep -c '^cache_purge_plan_format=1$' <<< "$activation_output" || true)
  [[ $marker_count == 1 ]] || die "activation returned an invalid cache purge plan"
  release_count=$(grep -c '^cache_purge_release=' <<< "$activation_output" || true)
  [[ $release_count == 1 ]] || die "activation returned an invalid cache purge release"
  purge_release=$(sed -n 's/^cache_purge_release=//p' <<< "$activation_output")
  valid_release_id "$purge_release"
  while IFS= read -r line; do
    [[ $line == cache_purge_path=* ]] || continue
    stable_path=${line#cache_purge_path=}
    [[ $stable_path =~ ^/[A-Za-z0-9._~%/-]*$ \
      && $stable_path != *'//'* && $stable_path != *'/./'* && $stable_path != *'/../'* \
      && $stable_path != */. && $stable_path != */.. ]] \
      || die "activation returned an unsafe cache purge path"
    [[ -z $previous_path || $stable_path > $previous_path ]] \
      || die "activation returned unsorted or duplicate cache purge paths"
    paths+=("$stable_path")
    previous_path=$stable_path
  done <<< "$activation_output"
  if (( ${#paths[@]} == 0 )); then
    deploy_ssh "sudo -n /usr/local/sbin/galata-deploy-helper ack-cache-purge '$slot' '$purge_release'" \
      || die "remote cache purge acknowledgement failed; the next deploy will retry safely"
    note "No changed stable cache URLs; Cloudflare purge skipped"
    return
  fi
  if [[ $slot == dev ]]; then
    hostnames=(dev.galatadergisi.org)
  else
    hostnames=(galatadergisi.org www.galatadergisi.org)
  fi
  for hostname in "${hostnames[@]}"; do
    for stable_path in "${paths[@]}"; do
      urls+=("https://$hostname$stable_path")
    done
  done
  for ((offset = 0; offset < ${#urls[@]}; offset += 100)); do
    batch_end=$((offset + 100))
    (( batch_end <= ${#urls[@]} )) || batch_end=${#urls[@]}
    request_file=$(mktemp "${TMPDIR:-/tmp}/galata-cloudflare-purge.XXXXXX")
    chmod 0600 "$request_file"
    first=true
    printf '{"files":[' > "$request_file"
    for ((index = offset; index < batch_end; index += 1)); do
      if [[ $first == true ]]; then first=false; else printf ',' >> "$request_file"; fi
      url=${urls[$index]}
      printf '"%s"' "$url" >> "$request_file"
    done
    printf ']}\n' >> "$request_file"
    if ! response=$(curl --fail-with-body --silent --show-error --retry 3 \
        --request POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/purge_cache" \
        --header "Authorization: Bearer $CLOUDFLARE_CACHE_PURGE_TOKEN" \
        --header 'Content-Type: application/json' \
        --data-binary "@$request_file"); then
      rm -f "$request_file"
      die "Cloudflare URL purge request failed"
    fi
    rm -f "$request_file"
    if ! printf '%s' "$response" | node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        try { if (JSON.parse(input).success !== true) process.exitCode = 1; }
        catch { process.exitCode = 1; }
      });
    '; then
      die "Cloudflare rejected the URL purge: $response"
    fi
  done
  deploy_ssh "sudo -n /usr/local/sbin/galata-deploy-helper ack-cache-purge '$slot' '$purge_release'" \
    || die "Cloudflare purge succeeded but acknowledgement failed; the next deploy will retry safely"
  for hostname in "${hostnames[@]}"; do
    for stable_path in "${paths[@]}"; do
      note "Purged https://$hostname$stable_path"
    done
  done
}

sha_local() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

verify_media_inventory() {
  local inventory=$1 media_root=$2 line path expected actual
  sed 's/^[0-9a-f][0-9a-f]*  //' "$inventory" | LC_ALL=C sort -c >/dev/null \
    || die "media inventory paths are not sorted"
  while IFS= read -r line; do
    [[ $line =~ ^([0-9a-f]{64})\ \ (images|audio)/ ]] || die "malformed media inventory entry"
    expected=${line:0:64}; path=${line:66}
    [[ $path != /* && $path != *'/../'* && $path != ../* && -f $media_root/$path && ! -L $media_root/$path ]] \
      || die "unsafe or missing media path: $path"
    actual=$(sha_local "$media_root/$path")
    [[ $actual == "$expected" ]] || die "media checksum mismatch: $path"
  done < "$inventory"
  diff -u \
    <(sed 's/^[0-9a-f][0-9a-f]*  //' "$inventory") \
    <(cd "$media_root" && find images audio -type f -print | LC_ALL=C sort) >/dev/null \
    || die "media inventory and deployed file set differ"
}

make_bundle() {
  BUNDLE=$(mktemp -d "${TMPDIR:-/tmp}/galata-config.XXXXXX")
  chmod 0700 "$BUNDLE"
  cp "$DEPLOY_KEY_PATH.pub" "$BUNDLE/deploy-key.pub"
  cp "$REPO_ROOT/ops/nginx/galata-shared.conf" "$BUNDLE/"
  cp "$REPO_ROOT/ops/nginx/galata-security-headers.conf" "$BUNDLE/"
  cp "$REPO_ROOT/ops/nginx/galata-production-csp.conf" "$BUNDLE/"
  cp "$REPO_ROOT/ops/nginx/galata-dev-csp.conf" "$BUNDLE/"
  cp "$REPO_ROOT/ops/nginx/galatadergisi.org.conf" "$BUNDLE/"
  cp "$REPO_ROOT/ops/nginx/dev.galatadergisi.org.conf" "$BUNDLE/"
  cp "$REPO_ROOT/ops/logrotate/galata-nginx" "$BUNDLE/"
  cp "$REPO_ROOT/ops/systemd/galata-server.service" "$BUNDLE/"
  cp "$REPO_ROOT/ops/systemd/galata-dev-server.service" "$BUNDLE/"
  cp "$REPO_ROOT/ops/systemd/cloudflared.service" "$BUNDLE/"
}

write_environments() {
  write_runtime_environment production > "$BUNDLE/production.env"
  write_runtime_environment dev > "$BUNDLE/dev.env"
  chmod 0600 "$BUNDLE/production.env" "$BUNDLE/dev.env"
}

configure_command() {
  local argument remote_dir helper_tmp
  [[ $# == 0 ]] || die "configure takes no options"
  [[ -t 0 ]] || die "configure is workstation-only and interactive"
  start_admin_control
  admin_ssh 'sudo -n true' || die "administrator connection or passwordless sudo failed"
  admin_ssh 'sudo -n apt-get install -y rsync logrotate'
  if [[ ! -e $DEPLOY_KEY_PATH && ! -e $DEPLOY_KEY_PATH.pub ]]; then
    read -r -p "Create deployment key at $DEPLOY_KEY_PATH? [y/N] " argument
    [[ $argument == y || $argument == Y ]] || die "cancelled"
    install -d -m 0700 "$(dirname "$DEPLOY_KEY_PATH")"
    ssh-keygen -q -t ed25519 -N '' -C galata-deploy -f "$DEPLOY_KEY_PATH"
  elif [[ ! -f $DEPLOY_KEY_PATH || ! -f $DEPLOY_KEY_PATH.pub ]]; then
    die "refusing to overwrite an incomplete deployment key pair at $DEPLOY_KEY_PATH"
  fi
  make_bundle
  write_environments
  remote_dir=$(admin_ssh 'mktemp -d /tmp/galata-phase2.XXXXXX')
  helper_tmp=$(admin_ssh 'mktemp /tmp/galata-deploy-helper.XXXXXX')
  admin_scp "$REPO_ROOT/ops/deploy-helper.sh" "$ADMIN_TARGET:$helper_tmp" >/dev/null
  admin_ssh "sudo -n install -m 0755 -o root -g root '$helper_tmp' /usr/local/sbin/galata-deploy-helper && rm -f '$helper_tmp'"
  admin_scp -r "$BUNDLE/." "$ADMIN_TARGET:$remote_dir/" >/dev/null
  if ! admin_ssh "sudo -n /usr/local/sbin/galata-deploy-helper configure '$remote_dir'"; then
    admin_ssh "rm -rf '$remote_dir'" || true
    die "remote configuration failed"
  fi
  admin_ssh "rm -rf '$remote_dir'"
  verify_host_keys
  stop_admin_control
  deploy_connection
  deploy_ssh '
    sudo -n /usr/local/sbin/galata-deploy-helper status >/dev/null || exit 10
    test ! -r /etc/galata/production.env \
      && test ! -r /etc/cloudflared/tunnel-token || exit 11
    if sudo -n id >/dev/null 2>&1; then exit 12; fi
  ' || die "fresh restricted deployment login or security-boundary validation failed"
  note "configuration complete; add the displayed known_hosts data and private key to GitHub Environments"
}

verify_host_keys() {
  local resolved host port scan remote_public normalized_scan normalized_remote known_hosts
  resolved=$(ssh -G "$ADMIN_TARGET")
  host=$(awk '$1 == "hostname" {print $2; exit}' <<< "$resolved")
  port=$(awk '$1 == "port" {print $2; exit}' <<< "$resolved")
  HOST_KEY_TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/galata-hostkeys.XXXXXX")
  chmod 0700 "$HOST_KEY_TEMP_DIR"
  scan="$HOST_KEY_TEMP_DIR/scan"
  remote_public="$HOST_KEY_TEMP_DIR/trusted"
  ssh-keyscan -t rsa,ecdsa,ed25519 -p "$port" "$host" > "$scan" 2>/dev/null \
    || die "ssh-keyscan failed"
  admin_ssh 'sudo -n sh -c '\''for f in /etc/ssh/ssh_host_*_key.pub; do cat "$f"; done'\''' > "$remote_public"
  normalized_scan=$(awk '
    $2 == "ssh-rsa" || $2 == "ecdsa-sha2-nistp256" || $2 == "ssh-ed25519" {
      print $2 " " $3
    }
  ' "$scan" | LC_ALL=C sort)
  normalized_remote=$(awk '
    $1 == "ssh-rsa" || $1 == "ecdsa-sha2-nistp256" || $1 == "ssh-ed25519" {
      print $1 " " $2
    }
  ' "$remote_public" | LC_ALL=C sort)
  [[ -n $normalized_scan && -n $normalized_remote ]] \
    || die "host-key verification produced an empty key set"
  [[ $normalized_scan == "$normalized_remote" ]] || die "scanned host keys do not match the trusted administrator connection"
  known_hosts=${GALATA_KNOWN_HOSTS_OUTPUT:-$DEPLOY_KEY_PATH.known_hosts}
  install -m 0600 "$scan" "$known_hosts"
  rm -rf "$HOST_KEY_TEMP_DIR"
  HOST_KEY_TEMP_DIR=
  note "GitHub GALATA_SSH_KNOWN_HOSTS: $known_hosts"
}

tunnel_command() {
  local rotate=false token= remote_script mode=reuse
  [[ ${1:-} == --rotate-token ]] && { rotate=true; shift; }
  [[ $# == 0 ]] || die "unknown tunnel-setup option"
  [[ -t 0 ]] || die "tunnel-setup is workstation-only and interactive"
  start_admin_control
  admin_ssh 'sudo -n true' || die "administrator connection or passwordless sudo failed"
  admin_ssh 'command -v cloudflared >/dev/null && sudo -n test -f /etc/systemd/system/cloudflared.service' \
    || die "cloudflared foundation is missing; run setup-server apply and deploy-server configure first"
  if [[ $rotate == true ]] || ! admin_ssh 'sudo -n test -s /etc/cloudflared/tunnel-token'; then
    read_secret 'Cloudflare Tunnel connector token'; token=$REPLY
    mode=install
  fi
  remote_script=$(admin_ssh 'mktemp /tmp/galata-tunnel.XXXXXX')
  admin_scp "$REPO_ROOT/ops/tunnel-remote.sh" "$ADMIN_TARGET:$remote_script" >/dev/null
  if [[ $mode == install ]]; then
    if ! printf '%s\n' "$token" | admin_ssh "sudo -n sh '$remote_script' install"; then
      admin_ssh "rm -f '$remote_script'" || true
      unset token REPLY
      die "Cloudflare Tunnel token installation failed"
    fi
    unset token REPLY
  elif ! admin_ssh "sudo -n sh '$remote_script' reuse"; then
    admin_ssh "rm -f '$remote_script'" || true
    die "Cloudflare Tunnel connector verification failed"
  fi
  admin_ssh "rm -f '$remote_script'"
  stop_admin_control
  note "Cloudflare Tunnel is connected; dashboard routes must target http://127.0.0.1:8080"
}

deploy_command() {
  local slot=${1:-}; shift || true
  local release_dir= media_root= argument architecture binary expected actual remote_status activation_output
  YES=false; valid_slot "$slot"
  while [[ $# -gt 0 ]]; do
    argument=$1; shift
    case $argument in
      --release-dir) [[ $# -gt 0 ]] || die "--release-dir needs a value"; release_dir=$1; shift ;;
      --media-root) [[ $# -gt 0 ]] || die "--media-root needs a value"; media_root=$1; shift ;;
      --yes) YES=true ;;
      *) die "unknown deploy option: $argument" ;;
    esac
  done
  [[ -n $release_dir && -n $media_root ]] || die "deploy needs --release-dir and --media-root"
  require_cloudflare_cache_purge_config
  release_dir=$(cd "$release_dir" && pwd); media_root=$(cd "$media_root" && pwd)
  validate_local_release "$release_dir" "$media_root"
  deploy_connection
  remote_status=$(deploy_ssh 'sudo -n /usr/local/sbin/galata-deploy-helper status')
  require_cache_plan_capability "$remote_status"
  architecture=$(sed -n 's/^architecture=//p' <<< "$remote_status")
  [[ $architecture == amd64 || $architecture == arm64 ]] || die "unsupported remote architecture: $architecture"
  binary="$release_dir/galata-server-linux-$architecture"; [[ -f $binary && ! -L $binary ]] || die "matching binary is missing"
  expected=$(manifest_value "binary_${architecture}_sha256" "$release_dir/RELEASE-MANIFEST")
  actual=$(sha_local "$binary"); [[ $actual == "$expected" ]] || die "binary checksum mismatch"
  preflight_space "$release_dir" "$media_root"
  confirm "Deploy $RELEASE_ID to $slot?"
  upload_release "$release_dir" "$media_root" "$binary"
  activation_output=$(deploy_ssh "sudo -n /usr/local/sbin/galata-deploy-helper activate '$slot' '$RELEASE_ID'")
  printf '%s\n' "$activation_output"
  purge_cloudflare_cache "$slot" "$activation_output"
}

preflight_space() {
  local release_dir=$1 media_root=$2 media_kb incoming_kb available_kb required_kb
  media_kb=$(du -sk "$media_root/images" "$media_root/audio" | awk '{sum += $1} END {print sum}')
  incoming_kb=$(du -sk "$release_dir" | awk '{print $1}')
  available_kb=$(deploy_ssh 'df -Pk /var/lib/galata-deploy | awk '\''NR==2 {print $4}'\''')
  required_kb=$((media_kb * 3 + incoming_kb + 2 * 1024 * 1024))
  (( available_kb >= required_kb )) || die "insufficient remote disk: need ${required_kb} KiB, have ${available_kb} KiB"
}

rsync_shell() {
  local item quoted=()
  for item in "${DEPLOY_SSH[@]}"; do printf -v item '%q' "$item"; quoted+=("$item"); done
  (IFS=' '; printf '%s' "${quoted[*]}")
}

human_kib() {
  awk -v kib="$1" 'BEGIN {
    if (kib >= 1048576) printf "%.1f GiB", kib / 1048576
    else if (kib >= 1024) printf "%.1f MiB", kib / 1024
    else printf "%d KiB", kib
  }'
}

upload_release() {
  local release_dir=$1 media_root=$2 binary=$3 stage ssh_shell
  local release_kb media_kb media_files
  local progress_args=(--progress --human-readable --stats)
  stage=$(mktemp -d "${TMPDIR:-/tmp}/galata-release.XXXXXX"); chmod 0700 "$stage"
  cp "$binary" "$stage/galata-server"
  cp "$release_dir/RELEASE-MANIFEST" "$release_dir/MEDIA-SHA256SUMS" \
    "$release_dir/CACHE-PURGE-MANIFEST" "$stage/"
  deploy_ssh "install -d -m 0750 '/var/lib/galata-deploy/incoming/$RELEASE_ID-$slot/media' /var/lib/galata-deploy/media-cache"
  ssh_shell=$(rsync_shell)
  if rsync --info=progress2 --version >/dev/null 2>&1; then
    progress_args=(--info=progress2 --human-readable --stats)
  fi
  release_kb=$(du -sk "$stage" | awk '{print $1}')
  media_kb=$(du -sk "$media_root/images" "$media_root/audio" | awk '{sum += $1} END {print sum}')
  media_files=$(wc -l < "$release_dir/MEDIA-SHA256SUMS" | tr -d ' ')
  note "Uploading application bundle ($(human_kib "$release_kb"))"
  rsync -a --delete "${progress_args[@]}" -e "$ssh_shell" \
    "$stage/" "$DEPLOY_TARGET:/var/lib/galata-deploy/incoming/$RELEASE_ID-$slot/"
  note "Uploading media ($media_files files, $(human_kib "$media_kb"))"
  # Explicit source trees avoid delete/filter-rule interoperability failures
  # between Apple's openrsync client and the server's upstream rsync.
  rsync -a --delete --link-dest=/var/lib/galata-deploy/media-cache \
    "${progress_args[@]}" -e "$ssh_shell" "$media_root/images" "$media_root/audio" \
    "$DEPLOY_TARGET:/var/lib/galata-deploy/incoming/$RELEASE_ID-$slot/media/"
  rm -rf "$stage"
}

verify_command() {
  local slot=${1:-}; shift || true
  local public=false remote_status release site_release health headers status location
  valid_slot "$slot"
  [[ ${1:-} == --public ]] && { public=true; shift; }
  [[ $# == 0 ]] || die "unknown verify option"
  deploy_connection
  remote_status=$(deploy_ssh "sudo -n /usr/local/sbin/galata-deploy-helper verify '$slot'")
  printf '%s\n' "$remote_status"
  if [[ $public == true ]]; then
    release=$(sed -n 's/.*release=\([^ ]*\).*/\1/p' <<< "$remote_status" | tail -1)
    valid_release_id "$release"; site_release=${release#*-}
    if [[ $slot == dev ]]; then
      headers=$(curl --silent --show-error --dump-header - --output /dev/null \
        https://dev.galatadergisi.org/healthz)
      status=$(awk 'NR == 1 { sub(/\r$/, "", $2); print $2; exit }' <<< "$headers")
      location=$(awk 'tolower($1) == "location:" { sub(/\r$/, "", $2); print $2; exit }' \
        <<< "$headers")
      case $status in 302|303|307) ;; *)
        die "the public dev hostname is not gated by Cloudflare Access"
      esac
      [[ $location == https://*/cdn-cgi/access/login/* ]] \
        || die "the public dev hostname did not redirect to Cloudflare Access"
      note "dev Cloudflare Access gate verified; authenticate in a browser to verify protected content"
    else
      for hostname in galatadergisi.org www.galatadergisi.org; do
        health=$(curl --fail --silent --show-error "https://$hostname/healthz")
        [[ $health == *"\"release\":\"$site_release\""* ]] \
          || die "$hostname does not serve the active origin release"
      done
    fi
    note "$slot Cloudflare Tunnel path verified"
  fi
}

rollback_command() {
  local slot=${1:-}; shift || true; local release= argument remote_status activation_output
  YES=false; valid_slot "$slot"
  while [[ $# -gt 0 ]]; do
    argument=$1; shift
    case $argument in --yes) YES=true ;; *) [[ -z $release ]] || die "too many rollback arguments"; release=$argument; valid_release_id "$release" ;; esac
  done
  require_cloudflare_cache_purge_config
  confirm "Rollback $slot${release:+ to $release}?"
  deploy_connection
  remote_status=$(deploy_ssh 'sudo -n /usr/local/sbin/galata-deploy-helper status')
  require_cache_plan_capability "$remote_status"
  if [[ -n $release ]]; then
    activation_output=$(deploy_ssh "sudo -n /usr/local/sbin/galata-deploy-helper rollback '$slot' '$release'")
  else
    activation_output=$(deploy_ssh "sudo -n /usr/local/sbin/galata-deploy-helper rollback '$slot'")
  fi
  printf '%s\n' "$activation_output"
  purge_cloudflare_cache "$slot" "$activation_output"
}

command=${1:-}
[[ -n $command ]] || { usage; exit 0; }
shift
case $command in
  configure) configure_command "$@" ;;
  tunnel-setup) tunnel_command "$@" ;;
  deploy) deploy_command "$@" ;;
  verify) verify_command "$@" ;;
  rollback) rollback_command "$@" ;;
  -h|--help|help) [[ $# == 0 ]] || die "help takes no arguments"; usage ;;
  *) usage >&2; die "unknown command: $command" ;;
esac
