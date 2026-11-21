---
file: ROADMAP.md
section: Phase E5 — Contract features
---
- [x] Read-only token allowlist getter (issue #299): `get_allowed_tokens()`
  returns the immutable deploy-time allowlist as `Vec<Address>`; an empty
  list still means any token. Two tests in
  `contracts/escrow/tests/token_allowlist.rs` cover the configured and empty
  cases. SDK `getAllowedTokens()` and regenerated bindings. No new storage
  key or error code.
