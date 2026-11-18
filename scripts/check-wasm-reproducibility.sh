#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temp_root="$(mktemp -d "${TMPDIR:-/tmp}/escrow reproducibility.XXXXXX")"
trap 'rm -rf "$temp_root"' EXIT

checkout_one="$temp_root/first checkout/contracts source"
checkout_two="$temp_root/elsewhere/second checkout/contracts source"
mkdir -p "$checkout_one" "$checkout_two"

copy_source() {
  tar -C "$repo_root" \
    --exclude='./.git' \
    --exclude='*/target' \
    --exclude='./target' \
    --exclude='*/node_modules' \
    --exclude='./node_modules' \
    -cf - . | tar -C "$1" -xf -
}

copy_source "$checkout_one"
copy_source "$checkout_two"

build_at() {
  local checkout="$1"
  bash "$checkout/scripts/build-wasm.sh"
}

build_at "$checkout_one"
build_at "$checkout_two"

wasm_one="$checkout_one/contracts/escrow/target/wasm32v1-none/release/docforum_escrow.wasm"
wasm_two="$checkout_two/contracts/escrow/target/wasm32v1-none/release/docforum_escrow.wasm"
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

hash_one="$(hash_file "$wasm_one")"
hash_two="$(hash_file "$wasm_two")"

printf 'First build:  %s\nSecond build: %s\n' "$hash_one" "$hash_two"
if [[ "$hash_one" != "$hash_two" ]]; then
  echo "WASM builds differ across checkout paths." >&2
  exit 1
fi
echo "WASM builds are byte-for-byte reproducible across checkout paths."
