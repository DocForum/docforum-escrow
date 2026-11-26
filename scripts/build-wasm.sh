#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [escrow|releaser-account]" >&2
}

if [[ $# -gt 1 ]]; then
  usage
  echo "build-wasm: expected at most one crate argument." >&2
  exit 2
fi

# Keep the historical no-argument invocation compatible: it builds escrow.
crate="escrow"
if [[ $# -eq 1 ]]; then
  crate="$1"
fi
case "$crate" in
  escrow)
    crate_dir="contracts/escrow"
    ;;
  releaser-account)
    crate_dir="contracts/releaser-account"
    ;;
  *)
    usage
    echo "build-wasm: unsupported crate '$crate' (choose escrow or releaser-account)." >&2
    exit 2
    ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$repo_root=."
export SOURCE_DATE_EPOCH=0
cd "$repo_root/$crate_dir"
cargo build --locked --target wasm32v1-none --release
