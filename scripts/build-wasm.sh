#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$repo_root=."
export SOURCE_DATE_EPOCH=0
cd "$repo_root/contracts/escrow"
cargo build --locked --target wasm32v1-none --release
