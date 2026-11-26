# #107 — Rust static analysis and supply-chain gate

CI now runs `cargo fmt --check`, pedantic `cargo clippy -- -D warnings`,
CoinFabrik Scout 0.3.17, cargo-deny 0.22.0 and cargo-audit 0.23.0, with
Rust 1.96.0 and every tool version pinned. Each suppression (one advisory
ignore, three Scout detector exclusions, duplicate-crate skips) has a
written reason and exit condition in `docs/supply-chain.md` and
`contracts/escrow/deny.toml`. No contract source, ABI or storage-layout
change: the id allocation, counter and entry points are as on main.
Closes #107.
