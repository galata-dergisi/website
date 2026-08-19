#!/bin/sh
set -eu

target="${ZAP_TARGET:-http://app:3000}"
response_file=$(mktemp)
trap 'rm -f "$response_file"' EXIT HUP INT TERM

assert_response() {
  expected_status=$1
  expected_code=$2
  actual_status=$3

  if [ "$actual_status" != "$expected_status" ] || \
    ! grep -F "\"code\":\"${expected_code}\"" "$response_file" >/dev/null
  then
    echo "Turnstile contract check expected HTTP ${expected_status} ${expected_code}." >&2
    cat "$response_file" >&2
    exit 3
  fi
}

status=$(curl --silent --show-error --max-time 10 \
  --output "$response_file" \
  --write-out '%{http_code}' \
  --form-string 'name=ZAP Scanner' \
  --form-string 'email=zap@example.invalid' \
  --form-string 'title=Turnstile contract' \
  --form-string 'assetType=video' \
  --form-string 'videoLink=https://video.example.invalid/watch' \
  --form-string 'contactWebsite=' \
  "${target}/katkida-bulunun")
assert_response 400 captcha_required "$status"

status=$(curl --silent --show-error --max-time 10 \
  --output "$response_file" \
  --write-out '%{http_code}' \
  --form-string 'name=ZAP Scanner' \
  --form-string 'email=zap@example.invalid' \
  --form-string 'title=Honeypot contract' \
  --form-string 'assetType=video' \
  --form-string 'videoLink=https://video.example.invalid/watch' \
  --form-string 'contactWebsite=https://spam.example.invalid/' \
  --form-string 'cf-turnstile-response=must-not-be-verified' \
  "${target}/katkida-bulunun")
assert_response 400 captcha_invalid "$status"

echo "Turnstile and honeypot rejection contracts verified."
