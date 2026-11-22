# #107 — contract changes from the static-analysis triage

No ABI, storage-layout or `CONTRACT_VERSION` change.

- The `next_id` helper was inlined into `create_escrow` after its
  `payer.require_auth()` check, so every storage write is in the same
  function as the authorization that gates it (Scout
  `set-contract-storage` triage).
- The counter uses `saturating_add(1)` instead of an unchecked `+`.
  Reaching the `u64` limit would require more escrows than can be funded;
  behaviour is otherwise identical.
- `# Errors` rustdoc sections were added to the five public functions for
  clippy `missing_errors_doc`. No logic change.

Existing coverage remains green: 31/31 tests across
`tests/create_escrow.rs`, `tests/release_refund.rs`,
`tests/timeout_refund.rs` and `tests/malicious_token.rs`, plus the
wasm32v1-none release build.
