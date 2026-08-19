#!/bin/sh
set -eu

PROGRAM=${0##*/}
TOKEN_PATH=/etc/cloudflared/tunnel-token
METRICS_URL=http://127.0.0.1:20241/metrics

die() {
  printf '%s: %s\n' "$PROGRAM" "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "must run as root"
[ "$#" -eq 1 ] || die "expected install or reuse mode"
mode=$1
case "$mode" in install|reuse) ;; *) die "invalid mode: $mode" ;; esac

valid_token_file() {
  [ -f "$TOKEN_PATH" ] && [ ! -L "$TOKEN_PATH" ] && [ -s "$TOKEN_PATH" ] \
    || die "tunnel token is missing or unsafe"
  [ "$(stat -c '%U:%G %a' "$TOKEN_PATH")" = 'root:root 600' ] \
    || die "tunnel token permissions are unsafe"
  token_lines=$(wc -l < "$TOKEN_PATH" | tr -d ' ')
  [ "$token_lines" -eq 1 ] || die "tunnel token must contain exactly one line"
  token=$(sed -n '1p' "$TOKEN_PATH")
  printf '%s' "$token" | grep -Eq '^[A-Za-z0-9._~+/=-]{100,4096}$' \
    || die "tunnel token format is invalid"
}

wait_for_connections() {
  attempts=0
  while [ "$attempts" -lt 45 ]; do
    if curl --fail --silent --show-error --max-time 2 "$METRICS_URL" 2>/dev/null \
        | awk '
          $1 ~ /^cloudflared_tunnel_ha_connections(\{.*\})?$/ { total += $2 }
          END { exit total >= 1 ? 0 : 1 }
        '; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  return 1
}

install -d -m 0700 -o root -g root /etc/cloudflared
backup=$(mktemp /etc/cloudflared/.tunnel-token-backup.XXXXXX)
had_token=false
if [ -e "$TOKEN_PATH" ] || [ -L "$TOKEN_PATH" ]; then
  valid_token_file
  cp -p "$TOKEN_PATH" "$backup"
  had_token=true
fi
was_enabled=$(systemctl is-enabled cloudflared.service 2>/dev/null || true)
state_changed=false
committed=false

restore_previous() {
  if [ "$had_token" = true ]; then
    install -m 0600 -o root -g root "$backup" "$TOKEN_PATH"
  else
    rm -f "$TOKEN_PATH"
  fi
  if [ "$was_enabled" = enabled ]; then
    systemctl enable cloudflared.service >/dev/null 2>&1 || true
    systemctl restart cloudflared.service >/dev/null 2>&1 || true
  else
    systemctl disable --now cloudflared.service >/dev/null 2>&1 || true
  fi
  rm -f "$backup"
}

cleanup() {
  status=$?
  trap - EXIT
  if [ "$state_changed" = true ] && [ "$committed" = false ]; then
    restore_previous
  else
    rm -f "$backup"
  fi
  exit "$status"
}
trap cleanup EXIT

if [ "$mode" = install ]; then
  IFS= read -r token || die "tunnel token is required"
  if IFS= read -r extra_line; then
    die "tunnel token input contains extra lines"
  fi
  printf '%s' "$token" | grep -Eq '^[A-Za-z0-9._~+/=-]{100,4096}$' \
    || die "tunnel token format is invalid"
  temporary=$(mktemp /etc/cloudflared/.tunnel-token.XXXXXX)
  printf '%s\n' "$token" > "$temporary"
  state_changed=true
  install -m 0600 -o root -g root "$temporary" "$TOKEN_PATH"
  rm -f "$temporary"
  unset token
else
  valid_token_file
fi

systemctl daemon-reload
state_changed=true
if ! systemctl enable cloudflared.service >/dev/null \
    || ! systemctl restart cloudflared.service \
    || ! wait_for_connections; then
  die "tunnel did not establish an active Cloudflare connection; previous state restored"
fi

committed=true
printf '%s\n' 'Cloudflare Tunnel connector is active.'
