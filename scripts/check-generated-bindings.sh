#!/usr/bin/env bash
#
# Issue #121: sdk/src/generated/contract-client.ts must be exactly what the
# pinned Stellar CLI generates from the current contract WASM. Nothing else
# enforces "never hand-edit", and a stale binding means the SDK sends the wrong
# arguments to a contract it claims to support.
#
# This script never writes the committed file. It regenerates into a temp
# directory and diffs, so the contributor (not CI) decides to commit the
# regeneration.
#
# Usage:
#   ./scripts/check-generated-bindings.sh
#
# Requires: cargo with the wasm32v1-none target, and the Stellar CLI version
# pinned in scripts/stellar-cli-version on PATH (or STELLAR_BIN set to it).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version_file="$repo_root/scripts/stellar-cli-version"
pinned_version="$(sed -n 's/^version=//p' "$version_file")"
committed="$repo_root/sdk/src/generated/contract-client.ts"
wasm="$repo_root/contracts/escrow/target/wasm32v1-none/release/docforum_escrow.wasm"

if [[ -z "$pinned_version" ]]; then
  echo "error: could not read version= from $version_file" >&2
  exit 1
fi

stellar_bin="${STELLAR_BIN:-}"
if [[ -z "$stellar_bin" ]]; then
  stellar_bin="$(command -v stellar || true)"
fi
if [[ -z "$stellar_bin" ]]; then
  echo "error: stellar CLI not found. Install version ${pinned_version} (see $version_file)." >&2
  exit 1
fi

installed_version="$("$stellar_bin" --version | head -n 1 | awk '{print $2}')"
if [[ "$installed_version" != "$pinned_version" ]]; then
  echo "error: stellar CLI ${installed_version} is installed, but ${pinned_version} is pinned." >&2
  echo "       Generator output is only comparable between identical CLI versions." >&2
  echo "       Install ${pinned_version}, or bump $(basename "$version_file") deliberately." >&2
  exit 1
fi

echo "Building contract WASM..."
(cd "$repo_root/contracts/escrow" && cargo build --target wasm32v1-none --release)
if [[ ! -f "$wasm" ]]; then
  echo "error: expected WASM at $wasm after the build" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

echo "Generating bindings with stellar CLI ${pinned_version}..."
"$stellar_bin" contract bindings typescript \
  --wasm "$wasm" \
  --output-dir "$tmp_dir/bindings" \
  --overwrite >/dev/null
generated="$tmp_dir/bindings/src/index.ts"

if [[ ! -f "$generated" ]]; then
  echo "error: generator produced no src/index.ts" >&2
  exit 1
fi

# Only src/index.ts is committed: the generator's README.md/package.json embed
# the output directory's name, so they are neither deterministic nor used here.
if ! diff -u "$committed" "$generated"; then
  cat >&2 <<EOF

sdk/src/generated/contract-client.ts is out of date.

The committed file does not match what stellar CLI ${pinned_version} generates
from contracts/escrow/target/wasm32v1-none/release/docforum_escrow.wasm. Either
the contract's public surface changed without regenerating the bindings, or the
generated file was edited by hand (it must never be).

Regenerate it:

  cd contracts/escrow
  cargo build --target wasm32v1-none --release
  stellar contract bindings typescript \\
    --wasm target/wasm32v1-none/release/docforum_escrow.wasm \\
    --output-dir /tmp/escrow-bindings --overwrite
  cp /tmp/escrow-bindings/src/index.ts ../../sdk/src/generated/contract-client.ts

then review and commit the regenerated file with your contract change. See
sdk/src/generated/README.md.
EOF
  exit 1
fi

echo "OK: generated bindings match the contract WASM (stellar CLI ${pinned_version})."
