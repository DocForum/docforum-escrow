bump: patch
---
#107: CI-only gate (issue #107). No contract source, ABI, storage-layout
or CONTRACT_VERSION change. Adds cargo fmt --check, pedantic cargo
clippy -D warnings, Scout, cargo-deny and cargo-audit jobs plus the lint
policy in contracts/escrow/Cargo.toml and docs/supply-chain.md.
