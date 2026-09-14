# ARCHITECTURE_ESSENTIALS.md — docforum-escrow

## Stack
- **Contract**: Rust, Soroban SDK, targeting Stellar testnet first, mainnet
  only after a real security review (not yet scheduled — see ROADMAP.md).
- **SDK**: TypeScript, wraps `@stellar/stellar-sdk` + generated contract
  bindings, published as `@docforum/escrow-sdk` on npm.
- No database. No server. This repo ships a contract + a client library —
  nothing here runs as a persistent service.

## Contract surface
```
create_escrow(payer, payee, token, amount, condition_ref) -> escrow_id   // IMPLEMENTED (Phase E1)
get_status(escrow_id) -> EscrowStatus  // enum: Funded | Released | Refunded — IMPLEMENTED (Phase E1)
release(escrow_id, caller) -> result   // TODO Phase E2 — only the designated releaser role may call this
refund(escrow_id, caller) -> result    // TODO Phase E2 — for expired/rejected condition_ref
```
`create_escrow`'s param order in code is `(payer, payee, token, amount, condition_ref)` —
`token` before `amount` — differs slightly from the original sketch above; no
behavioral difference, just noting it so this doc and `src/lib.rs` don't
drift.
`condition_ref` is an **opaque string/id** the contract does not interpret
— it's the caller's job (e.g. `docforum-core`) to decide when release is
warranted and call `release()`. The contract enforces *who* can call
release/refund, not *why* — keep it that way. Baking healthcare-specific
logic into the contract is exactly the scope creep this repo exists to
avoid (see README "why this repo exists, honestly").

## Hard rules
1. **No PHI, ever, anywhere in this repo.** Not in tests, not in example
   fixtures, not in comments. This repo should be safely public and
   understandable with zero healthcare context.
2. Contract logic changes require updated tests in
   `contracts/escrow/tests/` before merge — payment logic bugs are not
   "fix in a follow-up" territory.
3. SDK version bumps that change the public API are breaking changes —
   semver strictly, since `docforum-core` pins a version rather than
   tracking latest.
4. Testnet only until a security review has happened. Do not wire mainnet
   contract addresses into the SDK's defaults.

## Roadmap / status
See `ROADMAP.md` in this repo.
