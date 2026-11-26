---
file: ARCHITECTURE_ESSENTIALS.md
section: Phase E3 — TypeScript SDK
---

### Verification gates

The CI gate for issue #107 runs rustfmt, pedantic clippy (via the
`[lints]` table in `contracts/escrow/Cargo.toml`), CoinFabrik Scout
0.3.17, cargo-deny 0.22.0 and cargo-audit 0.23.0. Versions are pinned in
CI and in `rust-toolchain.toml`; every suppression carries a written
reason and exit condition in `docs/supply-chain.md`.
