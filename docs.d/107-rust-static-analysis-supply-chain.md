# #107 — documentation for the verification gates

Contract surface unchanged; this fragment records the new onboarding and
architecture text.

`README.md`:
- "Getting started" now runs `cargo fmt --check`, `cargo clippy
  --all-targets -- -D warnings`, `cargo deny check` and `cargo audit`
  alongside `cargo test` / the wasm build, and points at
  `docs/supply-chain.md` for pinned versions and triage.
- The documentation table links `docs/supply-chain.md` and updates the
  ROADMAP range to Phase E1–E7.

`ARCHITECTURE_ESSENTIALS.md`:
- New "Verification gates" section naming rustfmt, pedantic clippy,
  Scout 0.3.17, cargo-deny 0.22.0 and cargo-audit 0.23.0, the pinning
  rule, and the requirement that every suppression has a reason and exit
  condition in `docs/supply-chain.md`.
