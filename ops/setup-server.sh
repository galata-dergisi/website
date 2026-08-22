#!/bin/sh
# Copyright 2026 Mehmet Baker
#
# One-time Ubuntu 26.04 host bootstrap for Galata Dergisi. The public entry
# points run locally and send this same file to the target over SSH. Internal
# modes are intentionally undocumented and require root on the remote host.

set -eu

PROGRAM=${0##*/}
SSH_TARGET=galata
ADMIN_USER=
RUNTIME_USER=galata
SSH_LOGIN_GROUP=sshlogin
MANAGED_MARKER='Managed by ops/setup-server.sh'
SSH_OPTIONS='-o BatchMode=yes -o ConnectTimeout=10 -o ControlMaster=no -o ControlPath=none -o ControlPersist=no'

die() {
  printf '%s: %s\n' "$PROGRAM" "$*" >&2
  exit 1
}

warn() {
  printf '%s: warning: %s\n' "$PROGRAM" "$*" >&2
}

note() {
  printf '%s\n' "$*"
}

usage() {
  cat <<'EOF'
Usage:
  ./ops/setup-server.sh apply [--yes]
  ./ops/setup-server.sh verify

Commands:
  apply    Provision the Ubuntu 26.04 server reached through `ssh galata`.
           Prompts for the administrator username. Without --yes, the script
           also asks for explicit confirmation.
  verify   Run read-only host and fresh-connection verification.
           Prompts for the administrator username used during setup.

The script does not deploy an application build, create production secrets,
configure Cloudflare Tunnel routes or credentials, install the production
nginx virtual host, or modify the local SSH configuration.
EOF
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "internal remote mode requires root"
}

require_remote_mode() {
  [ "${GALATA_SETUP_REMOTE:-}" = 1 ] \
    || die "internal modes may only be invoked through the local orchestrator"
  export LC_ALL=C
}

validate_ssh_port() {
  case "$1" in
    ''|*[!0-9]*) die "invalid SSH port: $1" ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ] || die "invalid SSH port: $1"
}

validate_admin_user() {
  candidate=${1:-}
  case "$candidate" in
    ''|[!abcdefghijklmnopqrstuvwxyz_]*|*[!abcdefghijklmnopqrstuvwxyz0123456789_-]*)
      die "administrator username must match [a-z_][a-z0-9_-]*"
      ;;
  esac
  [ "${#candidate}" -le 32 ] \
    || die "administrator username must be at most 32 characters"
  [ "$candidate" != root ] \
    || die "root cannot be used as the administrator username"
  [ "$candidate" != "$RUNTIME_USER" ] \
    || die "$RUNTIME_USER is reserved for the application runtime account"
}

prompt_admin_user() {
  printf 'Administrator username: '
  IFS= read -r ADMIN_USER \
    || die "administrator username is required"
  validate_admin_user "$ADMIN_USER"
}

install_managed_file() {
  destination=$1
  mode=$2
  owner=$3
  group=$4
  temporary=$(mktemp)
  cat > "$temporary"
  [ ! -L "$destination" ] || {
    rm -f "$temporary"
    die "refusing to replace symlink: $destination"
  }

  if [ -f "$destination" ] && cmp -s "$temporary" "$destination"; then
    chown "$owner:$group" "$destination"
    chmod "$mode" "$destination"
    rm -f "$temporary"
    return
  fi

  install -o "$owner" -g "$group" -m "$mode" "$temporary" "$destination"
  rm -f "$temporary"
}

assert_managed_or_absent() {
  path=$1
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ ! -L "$path" ] && grep -Fq "$MANAGED_MARKER" "$path" \
      || die "refusing to overwrite unmanaged file: $path"
  fi
}

pro_status() {
  output=$(pro status --all 2>&1) || die "Ubuntu Pro status could not be read"
  printf '%s\n' "$output" | grep -qi 'not attached' \
    && die "Ubuntu Pro is not attached"
  printf '%s\n' "$output"
}

pro_service_enabled() {
  pro_service=$1
  pro_status_file=$(mktemp)
  if ! pro api u.pro.status.enabled_services.v1 > "$pro_status_file"; then
    rm -f "$pro_status_file"
    die "Ubuntu Pro enabled-service status could not be read"
  fi
  if grep -Eq \
    "\"name\"[[:space:]]*:[[:space:]]*\"$pro_service\"" \
    "$pro_status_file"; then
    pro_enabled=true
  else
    pro_enabled=false
  fi
  rm -f "$pro_status_file"
  [ "$pro_enabled" = true ]
}

enable_pro_service() {
  pro_service=$1
  pro_label=$2
  pro_service_enabled "$pro_service" && return

  if ! pro_output=$(pro enable --assume-yes "$pro_service" 2>&1); then
    printf '%s\n' "$pro_output" >&2
    die "could not enable $pro_label"
  fi
  pro_service_enabled "$pro_service" \
    || die "$pro_label did not report enabled after activation"
}

enable_optional_pro_service() {
  pro_service=$1
  pro_label=$2
  pro_service_enabled "$pro_service" && return

  if ! pro_output=$(pro enable --assume-yes "$pro_service" 2>&1); then
    printf '%s\n' "$pro_output" >&2
    return 1
  fi
  if ! pro_service_enabled "$pro_service"; then
    warn "$pro_label did not report enabled after activation"
    return 1
  fi
}

remote_preflight() {
  require_root
  [ -r /etc/os-release ] || die "/etc/os-release is missing"
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = ubuntu ] || die "expected Ubuntu, found ${ID:-unknown}"
  [ "${VERSION_ID:-}" = 26.04 ] \
    || die "expected Ubuntu 26.04, found ${VERSION_ID:-unknown}"

  architecture=$(dpkg --print-architecture)
  case "$architecture" in
    amd64|arm64) ;;
    *) die "unsupported architecture: $architecture" ;;
  esac

  audit_output=$(dpkg --audit)
  [ -z "$audit_output" ] || die "dpkg reports an unhealthy package state"
  [ ! -e /var/run/reboot-required ] \
    || die "a reboot is pending; reboot before running setup"
  command -v pro >/dev/null 2>&1 || die "Ubuntu Pro client is not installed"
  pro_status >/dev/null

  note "Remote preflight passed: Ubuntu 26.04 ($architecture), Pro attached."
}

remote_bootstrap_admin() {
  require_root
  ADMIN_USER=${1:-}
  validate_admin_user "$ADMIN_USER"
  [ -s /root/.ssh/authorized_keys ] \
    || die "root has no authorized_keys file to copy"

  getent group "$SSH_LOGIN_GROUP" >/dev/null 2>&1 \
    || groupadd --system "$SSH_LOGIN_GROUP"

  if id "$ADMIN_USER" >/dev/null 2>&1; then
    [ "$(id -u "$ADMIN_USER")" -ge 1000 ] \
      || die "$ADMIN_USER exists but is not a regular user"
    usermod -a -G sudo,"$SSH_LOGIN_GROUP" -s /bin/bash "$ADMIN_USER"
  else
    useradd --create-home --shell /bin/bash \
      --groups sudo,"$SSH_LOGIN_GROUP" "$ADMIN_USER"
  fi
  passwd -l "$ADMIN_USER" >/dev/null

  admin_home=$(getent passwd "$ADMIN_USER" | cut -d: -f6)
  [ -n "$admin_home" ] || die "could not resolve the administrator home"
  install -d -o "$ADMIN_USER" -g "$ADMIN_USER" -m 0700 "$admin_home/.ssh"
  if [ ! -e "$admin_home/.ssh/authorized_keys" ]; then
    install -o "$ADMIN_USER" -g "$ADMIN_USER" -m 0600 \
      /root/.ssh/authorized_keys "$admin_home/.ssh/authorized_keys"
  elif [ ! -s "$admin_home/.ssh/authorized_keys" ]; then
    die "$admin_home/.ssh/authorized_keys exists but is empty"
  else
    chown "$ADMIN_USER:$ADMIN_USER" "$admin_home/.ssh/authorized_keys"
    chmod 0600 "$admin_home/.ssh/authorized_keys"
  fi

  assert_managed_or_absent "/etc/sudoers.d/90-$ADMIN_USER"
  install_managed_file "/etc/sudoers.d/90-$ADMIN_USER" 0440 root root <<EOF
# $MANAGED_MARKER
$ADMIN_USER ALL=(ALL:ALL) NOPASSWD: ALL
EOF
  visudo -cf /etc/sudoers >/dev/null
  note "Administrator $ADMIN_USER is ready for fresh-login validation."
}

check_unmanaged_state() {
  if command -v ufw >/dev/null 2>&1; then
    unmanaged_added=$(ufw show added 2>/dev/null | awk '
      /^ufw (allow|limit)/ && $0 !~ /galata-ssh|galata-cloudflare-https/ { print }
    ')
    [ -z "$unmanaged_added" ] || {
      printf '%s\n' "$unmanaged_added" >&2
      die "UFW contains unmanaged configured allow/limit rules"
    }
    if ufw status 2>/dev/null | grep -q '^Status: active'; then
      unmanaged_ufw=$(ufw status | awk '
        /ALLOW|LIMIT/ && $0 !~ /galata-ssh|galata-cloudflare-https/ { print }
      ')
      [ -z "$unmanaged_ufw" ] || {
        printf '%s\n' "$unmanaged_ufw" >&2
        die "active UFW contains unmanaged allow/limit rules"
      }
    fi
  fi

  if [ -d /etc/nginx/sites-enabled ]; then
    for site in /etc/nginx/sites-enabled/*; do
      [ -e "$site" ] || [ -L "$site" ] || continue
      [ "${site##*/}" = default ] \
        || die "an unexpected nginx site is enabled: $site"
    done
  fi
  if [ -d /etc/nginx/conf.d ]; then
    for snippet in /etc/nginx/conf.d/*.conf; do
      [ -e "$snippet" ] || continue
      die "an unexpected nginx HTTP snippet exists: $snippet"
    done
  fi

  if [ -f /etc/systemd/system/galata-server.service ]; then
    app_enabled=$(systemctl is-enabled galata-server.service 2>/dev/null || true)
    [ "$app_enabled" = disabled ] \
      || die "galata-server.service is already enabled ($app_enabled)"
  fi

  for managed_path in \
    /etc/ssh/sshd_config.d/00-galata-hardening.conf \
    /etc/sysctl.d/99-galata-hardening.conf \
    /etc/apt/apt.conf.d/52galata-periodic \
    /etc/apt/apt.conf.d/53galata-unattended-upgrades \
    /etc/apt/sources.list.d/cloudflared.list \
    /etc/fail2ban/jail.d/galata-sshd.local \
    /etc/systemd/system/galata-server.service \
    /etc/systemd/system/galata-cis-audit.service \
    /etc/systemd/system/galata-cis-audit.timer \
    /etc/galata/production.env.example; do
    assert_managed_or_absent "$managed_path"
  done
}

enable_ufw_ipv6() {
  temporary=$(mktemp)
  if grep -q '^IPV6=' /etc/default/ufw; then
    sed 's/^IPV6=.*/IPV6=yes/' /etc/default/ufw > "$temporary"
  else
    cat /etc/default/ufw > "$temporary"
    printf '\nIPV6=yes\n' >> "$temporary"
  fi
  install -o root -g root -m 0644 "$temporary" /etc/default/ufw
  rm -f "$temporary"
}

delete_ufw_rules_by_marker() {
  marker=$1
  keep=${2:-}
  keep_action=${3:-}
  rule_numbers=$(ufw status numbered | awk \
      -v marker="$marker" -v keep="$keep" -v keep_action="$keep_action" '
    index($0, marker) && (keep == "" || index($0, keep) == 0 || \
      (keep_action != "" && index($0, keep_action) == 0)) {
      number = $0
      sub(/^[[:space:]]*\[[[:space:]]*/, "", number)
      sub(/\].*$/, "", number)
      gsub(/[[:space:]]/, "", number)
      if (number != "") print number
    }
  ' | sort -rn)
  for rule_number in $rule_numbers; do
    ufw --force delete "$rule_number" >/dev/null
  done
}

configure_firewall() {
  ssh_port=$1
  enable_ufw_ipv6

  # UFW's connection-count limiter cannot distinguish successful key
  # authentication from an attack. Establish the unrestricted key-only SSH
  # rule before removing the legacy LIMIT rule so the current administration
  # path remains recoverable throughout migration.
  ufw allow "$ssh_port/tcp" comment galata-ssh >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw default deny routed >/dev/null
  ufw logging low >/dev/null
  ufw --force enable >/dev/null
  delete_ufw_rules_by_marker galata-ssh "$ssh_port/tcp" 'ALLOW IN'
  delete_ufw_rules_by_marker galata-cloudflare-https
}

install_cloudflared_repository() {
  keyring=/usr/share/keyrings/cloudflare-main.gpg
  temporary=$(mktemp)
  install -d -o root -g root -m 0755 /usr/share/keyrings
  curl --fail --silent --show-error --location --proto '=https' \
    --proto-redir '=https' --tlsv1.2 \
    https://pkg.cloudflare.com/cloudflare-main.gpg > "$temporary"
  [ -s "$temporary" ] || {
    rm -f "$temporary"
    die "Cloudflare package signing key download was empty"
  }
  [ ! -L "$keyring" ] || {
    rm -f "$temporary"
    die "refusing to replace symlink: $keyring"
  }
  install -o root -g root -m 0644 "$temporary" "$keyring"
  rm -f "$temporary"

  install_managed_file /etc/apt/sources.list.d/cloudflared.list 0644 root root <<EOF
# $MANAGED_MARKER
deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main
EOF
}

assert_cloudflared_version() {
  command -v cloudflared >/dev/null 2>&1 || die "cloudflared is not installed"
  version=$(dpkg-query -W -f='${Version}' cloudflared 2>/dev/null) \
    || die "cloudflared is not managed by dpkg"
  dpkg --compare-versions "$version" ge 2025.4.0 \
    || die "cloudflared $version is older than required version 2025.4.0"
}

install_host_configuration() {
  ssh_port=$1

  timedatectl set-timezone Europe/Istanbul

  install_managed_file /etc/sysctl.d/99-galata-hardening.conf 0644 root root <<EOF
# $MANAGED_MARKER
fs.protected_fifos = 2
fs.protected_hardlinks = 1
fs.protected_regular = 2
fs.protected_symlinks = 1
fs.suid_dumpable = 0
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 2
kernel.unprivileged_bpf_disabled = 2
kernel.yama.ptrace_scope = 1
net.core.bpf_jit_harden = 2
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.default.secure_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_syncookies = 1
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv6.conf.default.accept_source_route = 0
EOF
  sysctl --system >/dev/null

  install_managed_file /etc/apt/apt.conf.d/52galata-periodic 0644 root root <<EOF
// $MANAGED_MARKER
APT::Periodic::Enable "1";
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  install_managed_file /etc/apt/apt.conf.d/53galata-unattended-upgrades 0644 root root <<EOF
// $MANAGED_MARKER
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
EOF
  systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null

  install_managed_file /etc/fail2ban/jail.d/galata-sshd.local 0644 root root <<EOF
# $MANAGED_MARKER
[sshd]
enabled = true
port = $ssh_port
backend = systemd
banaction = ufw
maxretry = 5
findtime = 10m
bantime = 1h
bantime.increment = true
bantime.factor = 2
bantime.maxtime = 1w
EOF
  fail2ban-client -t >/dev/null
  systemctl enable --now fail2ban.service >/dev/null
  systemctl restart fail2ban.service

  if [ -L /etc/nginx/sites-enabled/default ]; then
    rm /etc/nginx/sites-enabled/default
  elif [ -e /etc/nginx/sites-enabled/default ]; then
    die "/etc/nginx/sites-enabled/default is not the stock symlink"
  fi
  nginx -t
  systemctl enable --now nginx.service >/dev/null
  systemctl reload nginx.service
  systemctl enable --now logrotate.timer >/dev/null

  systemctl enable --now chrony.service >/dev/null
  systemctl enable auditd.service >/dev/null
  systemctl start auditd.service
  aa-status --enabled >/dev/null
}

install_runtime_foundation() {
  if id "$RUNTIME_USER" >/dev/null 2>&1; then
    runtime_shell=$(getent passwd "$RUNTIME_USER" | cut -d: -f7)
    case "$runtime_shell" in
      /usr/sbin/nologin|/bin/false) ;;
      *) die "$RUNTIME_USER exists with an interactive shell" ;;
    esac
  else
    useradd --system --user-group --home-dir /nonexistent \
      --shell /usr/sbin/nologin "$RUNTIME_USER"
  fi

  install -d -o root -g root -m 0755 /opt/galata /opt/galata/releases
  install -d -o root -g root -m 0750 /etc/galata
  install -d -o root -g www-data -m 0750 \
    /var/www/galatadergisi.org /var/www/galatadergisi.org/public

  install_managed_file /etc/galata/production.env.example 0600 root root <<EOF
# $MANAGED_MARKER
LISTEN_ADDR=127.0.0.1:3000
EOF

  install_managed_file /etc/systemd/system/galata-server.service 0644 root root <<EOF
# $MANAGED_MARKER
[Unit]
Description=Galata Dergisi immutable Go server
Wants=network-online.target
After=network-online.target
ConditionFileIsExecutable=/opt/galata/current/galata-server
ConditionPathExists=/etc/galata/production.env

[Service]
Type=simple
User=$RUNTIME_USER
Group=$RUNTIME_USER
WorkingDirectory=/opt/galata/current
EnvironmentFile=/etc/galata/production.env
ExecStart=/usr/bin/env /opt/galata/current/galata-server
Restart=on-failure
RestartSec=5s
TimeoutStopSec=25s
UMask=0077
LimitCORE=0
NoNewPrivileges=yes
PrivateDevices=yes
PrivateTmp=yes
ProtectClock=yes
ProtectControlGroups=yes
ProtectHome=yes
ProtectHostname=yes
ProtectKernelLogs=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
ProtectSystem=strict
CapabilityBoundingSet=
AmbientCapabilities=
LockPersonality=yes
MemoryDenyWriteExecute=yes
RemoveIPC=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
EOF

  if [ "${USG_ENABLED:-false}" != true ]; then
    systemctl daemon-reload
    systemd-analyze verify /etc/systemd/system/galata-server.service
    return
  fi

  install_managed_file /etc/systemd/system/galata-cis-audit.service 0644 root root <<EOF
# $MANAGED_MARKER
[Unit]
Description=Audit Galata VPS against CIS Level 1 Server
After=network-online.target

[Service]
Type=oneshot
Nice=19
IOSchedulingClass=idle
ExecStart=/usr/bin/usg audit cis_level1_server
EOF

  install_managed_file /etc/systemd/system/galata-cis-audit.timer 0644 root root <<EOF
# $MANAGED_MARKER
[Unit]
Description=Weekly CIS Level 1 audit for Galata VPS

[Timer]
OnCalendar=Sun *-*-* 05:30:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemd-analyze verify /etc/systemd/system/galata-server.service \
    /etc/systemd/system/galata-cis-audit.service \
    /etc/systemd/system/galata-cis-audit.timer
  systemctl enable --now galata-cis-audit.timer >/dev/null

  if ! find /var/lib/usg -type f \( -name '*.html' -o -name '*.xml' \) \
    -print -quit 2>/dev/null | grep -q .; then
    if ! usg audit cis_level1_server; then
      warn "the initial CIS audit reported non-compliance"
    fi
  fi
  find /var/lib/usg -type f \( -name '*.html' -o -name '*.xml' \) \
    -print -quit 2>/dev/null | grep -q . \
    || die "USG did not create an audit report"
}

install_final_ssh_policy() {
  policy=/etc/ssh/sshd_config.d/00-galata-hardening.conf
  candidate=$(mktemp /etc/ssh/sshd_config.d/.galata-hardening.XXXXXX)
  validation=$(mktemp /etc/ssh/.galata-sshd-config.XXXXXX)
  backup=$(mktemp)
  had_policy=false
  if [ -f "$policy" ]; then
    cp -p "$policy" "$backup"
    had_policy=true
  fi

  cat > "$candidate" <<EOF
# $MANAGED_MARKER
PubkeyAuthentication yes
AuthenticationMethods publickey
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
HostbasedAuthentication no
IgnoreRhosts yes
PermitEmptyPasswords no
PermitUserEnvironment no
AllowGroups $SSH_LOGIN_GROUP
DisableForwarding yes
X11Forwarding no
PermitTunnel no
StrictModes yes
LoginGraceTime 30
MaxAuthTries 3
MaxSessions 4
MaxStartups 10:30:30
ClientAliveInterval 300
ClientAliveCountMax 2
LogLevel VERBOSE
EOF
  chmod 0600 "$candidate"
  {
    printf 'Include %s\n' "$candidate"
    cat /etc/ssh/sshd_config
  } > "$validation"
  chmod 0600 "$validation"
  if ! sshd -t -f "$validation"; then
    rm -f "$candidate" "$validation" "$backup"
    die "candidate SSH hardening policy failed validation; existing access is unchanged"
  fi

  install -o root -g root -m 0644 "$candidate" "$policy"
  rm -f "$candidate" "$validation"
  if ! sshd -t || ! systemctl reload ssh.service; then
    if [ "$had_policy" = true ]; then
      install -o root -g root -m 0644 "$backup" "$policy"
    else
      rm -f "$policy"
    fi
    rm -f "$backup"
    sshd -t || warn "the restored SSH configuration also fails validation"
    systemctl reload ssh.service \
      || warn "SSH reload failed after restoring the previous configuration"
    die "SSH hardening validation/reload failed; the previous policy was restored"
  fi
  rm -f "$backup"
}

remote_apply() {
  require_root
  ADMIN_USER=${1:-}
  [ "$#" -eq 2 ] || die "administrator and SSH port are required"
  validate_admin_user "$ADMIN_USER"
  shift
  ssh_port=${1:-}
  validate_ssh_port "$ssh_port"

  remote_preflight
  id "$ADMIN_USER" >/dev/null 2>&1 || die "$ADMIN_USER is missing"
  id -nG "$ADMIN_USER" | tr ' ' '\n' | grep -qx "$SSH_LOGIN_GROUP" \
    || die "$ADMIN_USER is not in $SSH_LOGIN_GROUP"
  check_unmanaged_state

  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y --no-install-recommends ufw ca-certificates curl
  configure_firewall "$ssh_port"
  install_cloudflared_repository

  enable_pro_service esm-infra "Ubuntu Pro ESM Infra"
  enable_pro_service esm-apps "Ubuntu Pro ESM Apps"
  if ! enable_optional_pro_service livepatch "Ubuntu Pro Livepatch"; then
    warn "Livepatch is unavailable for this VPS kernel; unattended kernel updates remain enabled"
  fi
  USG_ENABLED=false
  if pro help usg >/dev/null 2>&1; then
    if enable_optional_pro_service usg "Ubuntu Security Guide"; then
      USG_ENABLED=true
    else
      warn "Ubuntu Security Guide could not be enabled; skipping the CIS audit"
    fi
  else
    warn "Ubuntu Security Guide is not published for Ubuntu 26.04; skipping the CIS audit"
  fi
  apt-get update
  if [ "$USG_ENABLED" = true ]; then
    apt-get install -y --no-install-recommends \
      nginx logrotate fail2ban unattended-upgrades chrony auditd apparmor-utils usg cloudflared
  else
    apt-get install -y --no-install-recommends \
      nginx logrotate fail2ban unattended-upgrades chrony auditd apparmor-utils cloudflared
  fi
  assert_cloudflared_version

  install_host_configuration "$ssh_port"
  install_runtime_foundation

  # This is deliberately the final mutation. Every earlier failure leaves the
  # original root-key SSH path available for recovery.
  install_final_ssh_policy
  note "Remote provisioning completed; validating fresh SSH sessions locally."
}

assert_service_active() {
  systemctl is-active --quiet "$1" || die "$1 is not active"
}

assert_service_enabled() {
  state=$(systemctl is-enabled "$1" 2>/dev/null || true)
  [ "$state" = enabled ] || die "$1 is not enabled ($state)"
}

assert_sysctl() {
  actual=$(sysctl -n "$1")
  [ "$actual" = "$2" ] || die "$1 is $actual, expected $2"
}

assert_ufw_default_policies() {
  ufw_defaults_file=${1:-/etc/default/ufw}
  [ -r "$ufw_defaults_file" ] || die "$ufw_defaults_file is not readable"
  awk -F= '
    /^[[:space:]]*DEFAULT_(INPUT|OUTPUT|FORWARD)_POLICY[[:space:]]*=/ {
      key = $1
      value = $2
      gsub(/[[:space:]"]/, "", key)
      gsub(/[[:space:]"]/, "", value)
      policy[key] = value
    }
    END {
      valid = policy["DEFAULT_INPUT_POLICY"] == "DROP" \
        && policy["DEFAULT_OUTPUT_POLICY"] == "ACCEPT" \
        && policy["DEFAULT_FORWARD_POLICY"] == "DROP"
      exit valid ? 0 : 1
    }
  ' "$ufw_defaults_file" || die "UFW default policy is not deny/allow/deny"
}

remote_verify() {
  require_root
  ADMIN_USER=${1:-}
  [ "$#" -eq 2 ] || die "administrator and SSH port are required"
  validate_admin_user "$ADMIN_USER"
  shift
  ssh_port=${1:-}
  validate_ssh_port "$ssh_port"

  remote_preflight
  sshd -t
  effective_ssh=$(sshd -T)
  for expected in \
    'pubkeyauthentication yes' \
    'authenticationmethods publickey' \
    'permitrootlogin no' \
    'passwordauthentication no' \
    'kbdinteractiveauthentication no' \
    'hostbasedauthentication no' \
    'permitemptypasswords no' \
    'permituserenvironment no' \
    'disableforwarding yes' \
    'x11forwarding no' \
    'permittunnel no' \
    'maxauthtries 3' \
    'logingracetime 30' \
    'loglevel VERBOSE'; do
    printf '%s\n' "$effective_ssh" | grep -Fxiq "$expected" \
      || die "effective SSH configuration lacks: $expected"
  done
  printf '%s\n' "$effective_ssh" | grep -Fxiq "allowgroups $SSH_LOGIN_GROUP" \
    || die "effective SSH configuration does not restrict AllowGroups"

  visudo -cf /etc/sudoers >/dev/null
  id -nG "$ADMIN_USER" | tr ' ' '\n' | grep -qx "$SSH_LOGIN_GROUP" \
    || die "$ADMIN_USER is not allowed to log in"
  admin_home=$(getent passwd "$ADMIN_USER" | cut -d: -f6)
  [ -n "$admin_home" ] || die "could not resolve the administrator home"
  [ "$(stat -c '%U:%G %a' "$admin_home/.ssh")" = \
    "$ADMIN_USER:$ADMIN_USER 700" ] || die "administrator .ssh permissions are wrong"
  [ "$(stat -c '%U:%G %a' "$admin_home/.ssh/authorized_keys")" = \
    "$ADMIN_USER:$ADMIN_USER 600" ] || die "administrator authorized_keys permissions are wrong"

  ufw status verbose | grep -q '^Status: active' || die "UFW is not active"
  assert_ufw_default_policies
  ufw status | grep -E "^$ssh_port/tcp[[:space:]]+ALLOW" | grep -q 'galata-ssh' \
    || die "the managed SSH UFW allow rule is missing"
  if ufw status | grep -E "^$ssh_port/tcp[[:space:]]+LIMIT" | grep -q 'galata-ssh'; then
    die "the legacy SSH connection-count limit is still active"
  fi
  unmanaged_ufw=$(ufw status | awk '
    /ALLOW|LIMIT/ && $0 !~ /galata-ssh/ { print }
  ')
  [ -z "$unmanaged_ufw" ] || die "UFW contains unmanaged allow/limit rules"
  ufw status | awk '$1 ~ /^(80|443|8080|3000|3001)(\/tcp)?$/ { found=1 } END { exit found ? 0 : 1 }' \
    && die "UFW unexpectedly exposes a web or application port"

  fail2ban-client -t >/dev/null
  fail2ban-client status sshd >/dev/null
  nginx -t
  if [ -d /etc/nginx/conf.d ]; then
    [ -z "$(find /etc/nginx/conf.d -mindepth 1 -maxdepth 1 -name '*.conf' -print -quit)" ] \
      || die "nginx has an HTTP snippet"
  fi
  if [ -d /etc/nginx/sites-enabled ]; then
    [ -z "$(find /etc/nginx/sites-enabled -mindepth 1 -maxdepth 1 -print -quit)" ] \
      || die "nginx has an enabled virtual host"
  fi
  ss -H -ltn | awk '$4 ~ /:(80|443|8080|3000|3001)$/ { print; found=1 } END { exit found ? 0 : 1 }' \
    && die "a web or application port is already listening"
  ss -H -ltn | awk -v port="$ssh_port" '$4 ~ (":" port "$") { found=1 } END { exit found ? 0 : 1 }' \
    || die "the expected SSH port is not listening"

  for service in nginx.service fail2ban.service chrony.service auditd.service; do
    assert_service_active "$service"
    assert_service_enabled "$service"
  done
  assert_service_active logrotate.timer
  assert_service_enabled logrotate.timer
  assert_cloudflared_version
  [ "$(stat -c '%U:%G %a' /usr/share/keyrings/cloudflare-main.gpg)" = 'root:root 644' ] \
    || die "Cloudflare package key permissions are wrong"
  grep -Fq '# Managed by ops/setup-server.sh' /etc/apt/sources.list.d/cloudflared.list \
    || die "cloudflared apt source is not managed"
  grep -Fq 'signed-by=/usr/share/keyrings/cloudflare-main.gpg' \
    /etc/apt/sources.list.d/cloudflared.list \
    || die "cloudflared apt source does not use the dedicated keyring"
  cloudflared_active=$(systemctl is-active cloudflared.service 2>/dev/null || true)
  [ "$cloudflared_active" = inactive ] || [ "$cloudflared_active" = unknown ] \
    || die "cloudflared.service is active before tunnel configuration"
  aa-status --enabled >/dev/null || die "AppArmor is not enabled"
  assert_service_enabled apt-daily.timer
  assert_service_enabled apt-daily-upgrade.timer
  USG_ENABLED=false
  if command -v usg >/dev/null 2>&1 && pro_service_enabled usg; then
    USG_ENABLED=true
    assert_service_enabled galata-cis-audit.timer
    assert_service_active galata-cis-audit.timer
  else
    warn "Ubuntu Security Guide is unavailable; CIS audit verification was skipped"
  fi
  [ "$(timedatectl show --property=Timezone --value)" = Europe/Istanbul ] \
    || die "server timezone is not Europe/Istanbul"

  apt_configuration=$(apt-config dump)
  printf '%s\n' "$apt_configuration" | grep -Fq 'APT::Periodic::Unattended-Upgrade "1";' \
    || die "daily unattended upgrades are not enabled"
  printf '%s\n' "$apt_configuration" | grep -Fq 'Unattended-Upgrade::Automatic-Reboot "true";' \
    || die "automatic security-update reboots are not enabled"
  printf '%s\n' "$apt_configuration" | grep -Fq 'Unattended-Upgrade::Automatic-Reboot-Time "04:30";' \
    || die "automatic reboot time is not 04:30"

  pro_service_enabled esm-apps || die "ESM Apps is not enabled"
  pro_service_enabled esm-infra || die "ESM Infra is not enabled"
  pro_service_enabled livepatch \
    || warn "Livepatch is not enabled for this VPS kernel"

  for pair in \
    'fs.protected_fifos 2' \
    'fs.protected_regular 2' \
    'kernel.dmesg_restrict 1' \
    'kernel.kptr_restrict 2' \
    'kernel.unprivileged_bpf_disabled 2' \
    'net.ipv4.conf.all.accept_redirects 0' \
    'net.ipv4.tcp_syncookies 1' \
    'net.ipv6.conf.all.accept_redirects 0'; do
    key=${pair% *}
    value=${pair##* }
    assert_sysctl "$key" "$value"
  done

  [ "$(stat -c '%U:%G %a' /etc/galata/production.env.example)" = 'root:root 600' ] \
    || die "environment template permissions are wrong"
  [ ! -e /etc/galata/production.env ] \
    || die "production.env exists before the deployment phase"
  [ ! -e /opt/galata/current ] \
    || die "an application release is active before the deployment phase"

  app_enabled=$(systemctl is-enabled galata-server.service 2>/dev/null || true)
  [ "$app_enabled" = disabled ] || die "galata-server.service is $app_enabled"
  app_active=$(systemctl is-active galata-server.service 2>/dev/null || true)
  [ "$app_active" = inactive ] || die "galata-server.service is $app_active"
  if [ "$USG_ENABLED" = true ]; then
    systemd-analyze verify /etc/systemd/system/galata-server.service \
      /etc/systemd/system/galata-cis-audit.service \
      /etc/systemd/system/galata-cis-audit.timer
    find /var/lib/usg -type f \( -name '*.html' -o -name '*.xml' \) \
      -print -quit 2>/dev/null | grep -q . || die "no CIS audit report exists"
  else
    systemd-analyze verify /etc/systemd/system/galata-server.service
  fi

  note "Remote verification passed."
}

ssh_fresh() {
  # Word splitting is intentional: SSH_OPTIONS contains only fixed options.
  # shellcheck disable=SC2086
  ssh $SSH_OPTIONS "$@"
}

local_paths() {
  SCRIPT_PATH=$(CDPATH= cd "$(dirname "$0")" && pwd)/${0##*/}
}

run_root_script() {
  mode=$1
  shift
  arguments="$*"
  # Internal arguments are fixed tokens and a validated username/port.
  # shellcheck disable=SC2029
  ssh_fresh "$SSH_TARGET" \
    "GALATA_SETUP_REMOTE=1 sh -s -- $mode $arguments" < "$SCRIPT_PATH"
}

run_admin_script() {
  mode=$1
  shift
  arguments="$*"
  # Internal arguments are fixed tokens and a validated username/port.
  # shellcheck disable=SC2029
  ssh_fresh -l "$ADMIN_USER" "$SSH_TARGET" \
    "sudo -n env GALATA_SETUP_REMOTE=1 sh -s -- $mode $arguments" < "$SCRIPT_PATH"
}

admin_ready() {
  ssh_fresh -l "$ADMIN_USER" "$SSH_TARGET" 'sudo -n true' >/dev/null 2>&1
}

root_ready() {
  ssh_fresh "$SSH_TARGET" 'test "$(id -u)" -eq 0' >/dev/null 2>&1
}

connection_port() {
  connection=$(ssh_fresh -l "$ADMIN_USER" "$SSH_TARGET" \
    'printf "%s\n" "$SSH_CONNECTION"')
  port=$(printf '%s\n' "$connection" | awk '{ print $4 }')
  validate_ssh_port "$port"
  printf '%s\n' "$port"
}

show_target() {
  resolved=$(ssh -G "$SSH_TARGET" 2>/dev/null)
  host=$(printf '%s\n' "$resolved" | awk '$1 == "hostname" { print $2; exit }')
  port=$(printf '%s\n' "$resolved" | awk '$1 == "port" { print $2; exit }')
  user=$(printf '%s\n' "$resolved" | awk '$1 == "user" { print $2; exit }')
  note "Target: $SSH_TARGET (${user:-unknown}@${host:-unknown}:${port:-unknown})"
  note "New administrator: $ADMIN_USER (key-only SSH, NOPASSWD sudo)"
  note "Firewall: key-only SSH with Fail2ban; no inbound web ports"
  note "Application and nginx virtual host: prepared but inactive"
}

confirm_apply() {
  [ "${1:-}" = --yes ] && return
  printf 'Type APPLY to continue: '
  IFS= read -r answer
  [ "$answer" = APPLY ] || die "cancelled"
}

verify_root_rejected() {
  if ssh_fresh -l root "$SSH_TARGET" true >/dev/null 2>&1; then
    die "fresh root SSH login still succeeds"
  fi
}

local_verify() {
  prompt_admin_user
  admin_ready || die "fresh $ADMIN_USER login with passwordless sudo failed"
  ssh_port=$(connection_port)
  run_admin_script _remote-verify "$ADMIN_USER" "$ssh_port"
  verify_root_rejected
  note "Fresh administrator login succeeds and fresh root login is rejected."
}

local_apply() {
  yes_flag=${1:-}
  local_paths
  prompt_admin_user
  show_target
  confirm_apply "$yes_flag"

  if admin_ready; then
    note "Existing $ADMIN_USER administration path detected; using it for this rerun."
    run_admin_script _remote-preflight
  else
    root_ready || die "neither root nor $ADMIN_USER can administer $SSH_TARGET"
    run_root_script _remote-preflight
    run_root_script _remote-bootstrap-admin "$ADMIN_USER"
    admin_ready || die "fresh $ADMIN_USER login/sudo validation failed; root SSH remains enabled"
    note "Fresh $ADMIN_USER login and passwordless sudo validated."
  fi

  ssh_port=$(connection_port)
  run_admin_script _remote-apply "$ADMIN_USER" "$ssh_port"
  admin_ready || die "administrator access failed after SSH hardening"
  run_admin_script _remote-verify "$ADMIN_USER" "$ssh_port"
  verify_root_rejected

  note "Server setup and verification completed."
  note "Update the local SSH host entry for '$SSH_TARGET' from 'User root' to 'User $ADMIN_USER'."
}

main() {
  case "${1:-}" in
    apply)
      case "${2:-}" in
        '') local_apply ;;
        --yes) [ "$#" -eq 2 ] || die "unexpected apply arguments"; local_apply --yes ;;
        *) die "unknown apply option: ${2:-}" ;;
      esac
      ;;
    verify)
      [ "$#" -eq 1 ] || die "verify takes no arguments"
      local_paths
      local_verify
      ;;
    -h|--help|'')
      usage
      ;;
    _remote-preflight)
      require_remote_mode
      remote_preflight
      ;;
    _remote-bootstrap-admin)
      require_remote_mode
      shift
      remote_bootstrap_admin "$@"
      ;;
    _remote-apply)
      require_remote_mode
      shift
      remote_apply "$@"
      ;;
    _remote-verify)
      require_remote_mode
      shift
      remote_verify "$@"
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
