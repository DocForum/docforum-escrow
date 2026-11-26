#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [escrow|releaser-account]" >&2
}

if [[ $# -gt 1 ]]; then
  usage
  echo "check-wasm-reproducibility: expected at most one crate argument." >&2
  exit 2
fi

# Keep the historical no-argument invocation compatible: it checks escrow.
crate="escrow"
if [[ $# -eq 1 ]]; then
  crate="$1"
fi
case "$crate" in
  escrow)
    artifact="docforum_escrow.wasm"
    ;;
  releaser-account)
    artifact="docforum_releaser_account.wasm"
    ;;
  *)
    usage
    echo "check-wasm-reproducibility: unsupported crate '$crate' (choose escrow or releaser-account)." >&2
    exit 2
    ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temp_root="$(mktemp -d "${TMPDIR:-/tmp}/docforum-${crate} reproducibility.XXXXXX")"
trap 'rm -rf "$temp_root"' EXIT

checkout_one="$temp_root/first checkout/source"
checkout_two="$temp_root/elsewhere/second checkout/source"
mkdir -p "$checkout_one" "$checkout_two"

copy_source() {
  tar -C "$repo_root" \
    --exclude='./.git' \
    --exclude='./target' \
    --exclude='*/target' \
    --exclude='./node_modules' \
    --exclude='*/node_modules' \
    --exclude='./.venv' \
    --exclude='*/.venv' \
    --exclude='*/__pycache__' \
    -cf - . | tar -C "$1" -xf -
}

copy_source "$checkout_one"
copy_source "$checkout_two"

build_at() {
  local checkout="$1"
  bash "$checkout/scripts/build-wasm.sh" "$crate"
}

build_at "$checkout_one"
build_at "$checkout_two"

wasm_one="$checkout_one/contracts/$crate/target/wasm32v1-none/release/$artifact"
wasm_two="$checkout_two/contracts/$crate/target/wasm32v1-none/release/$artifact"
if [[ ! -f "$wasm_one" || ! -f "$wasm_two" ]]; then
  echo "check-wasm-reproducibility: expected $artifact was not produced for $crate." >&2
  exit 1
fi

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

hash_one="$(hash_file "$wasm_one")"
hash_two="$(hash_file "$wasm_two")"
printf 'Crate:        %s\nFirst build:  %s\nSecond build: %s\n' \
  "$crate" "$hash_one" "$hash_two"
if [[ "$hash_one" != "$hash_two" ]]; then
  echo "WASM builds for $crate differ across checkout paths." >&2
  exit 1
fi
echo "WASM builds for $crate are byte-for-byte reproducible across checkout paths."
