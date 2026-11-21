# 299 — Expose the deploy-time token allowlist with `get_allowed_tokens()`

## Added

- Contract: `get_allowed_tokens() -> Vec<Address>` — read-only, no
  caller/auth, returns the immutable token allowlist this instance was
  deployed with. An **empty** list means any token is accepted, including
  when the storage key is absent (the getter returns an empty list rather
  than trapping).
- Contract: `__constructor(allowed_tokens: Vec<Address>)` — stores the
  allowlist once at deployment, with no setter.
- Contract: `create_escrow` now rejects a token that is not on a
  non-empty allowlist with `Error::TokenNotAllowed` (provisional code
  `29901`, issue number × 100 + 1) before the funding transfer runs, so
  a rejected attempt moves no funds.
- SDK: `EscrowClient.getAllowedTokens(): Promise<string[]>` — read-only
  wrapper over the getter. Bindings regenerated from the wasm.
- Tests: `contracts/escrow/tests/token_allowlist.rs` (configured
  accept/reject, empty list, multi-token getter, rejection precedes the
  transfer) and `sdk/tests/allowlist.test.ts` (offline, mocked
  simulation; now run in CI by `npm test`).

## Breaking note

Deploying now requires the constructor argument
(`stellar contract deploy ... -- --allowed_tokens '[]'`). Existing
test registrations pass an explicit empty list, so their behaviour is
unchanged. `create_escrow`'s signature and `EscrowData` are untouched;
`get_allowed_tokens` is additive. The contract has not been redeployed
to testnet in this change.

## Security

The allowlist is enforced before any token interaction and cannot be
changed after deployment (no admin path, no setter). Reading it on-chain
is the intended way to verify what a contract id accepts.
