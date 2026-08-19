#!/bin/sh

write_runtime_environment() {
  [ "$#" -eq 2 ] || return 2
  case "$1" in
    production)
      printf '%s\n' \
        'LISTEN_ADDR=127.0.0.1:3000' \
        'CONTRIBUTIONS_DIR=/var/lib/galata-contributions' \
        'EXTERNAL_MEDIA_DIR=/var/www/galatadergisi.org/public' \
        'TURNSTILE_ALLOWED_HOSTNAMES=galatadergisi.org,www.galatadergisi.org'
      ;;
    dev)
      printf '%s\n' \
        'LISTEN_ADDR=127.0.0.1:3001' \
        'CONTRIBUTIONS_DIR=/var/lib/galata-dev-contributions' \
        'EXTERNAL_MEDIA_DIR=/var/www/dev.galatadergisi.org/public' \
        'TURNSTILE_ALLOWED_HOSTNAMES=dev.galatadergisi.org'
      ;;
    *) return 2 ;;
  esac
  printf 'TURNSTILE_SECRET_KEY=%s\n' "$2"
}
