#!/bin/sh

write_runtime_environment() {
  [ "$#" -eq 1 ] || return 2
  case "$1" in
    production)
      printf '%s\n' 'LISTEN_ADDR=127.0.0.1:3000'
      ;;
    dev)
      printf '%s\n' 'LISTEN_ADDR=127.0.0.1:3001'
      ;;
    *) return 2 ;;
  esac
}
