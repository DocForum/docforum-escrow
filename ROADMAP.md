# ROADMAP.md — docforum-escrow

> Update this file on every contribution that starts/completes/blocks an
> item below.

**Status: Phase E1 mostly done (testnet deploy still manual). Phase E2 not started.**

## Phase E1 — Contract skeleton
- [x] Soroban project scaffold (`contracts/escrow`), builds to wasm
  (`cargo build --target wasm32v1-none --release`) — 4 passing tests in
  `contracts/escrow/tests/create_escrow.rs`.
- [ ] Deploy to testnet as a no-op — **not done**. Needs a funded Stellar
  testnet identity + `stellar`/`soroban` CLI, neither of which exist in
  this environment. Manual follow-up — tracked as issue #1.
- [x] `create_escrow` — locks funds (calls the SEP-41 token contract's
  `transfer`), assigns a sequential `escrow_id`, stores payer/payee/amount/
  opaque `condition_ref`, status `Funded`. Rejects non-positive amounts.
- [x] `get_status` — read-only status query, errors on unknown id.

## Phase E2 — Release & refund
- [ ] `release` — restricted to a designated releaser identity/role, moves
  funds to payee. Tracked as issue #2 (includes its own tests, per
  AGENTS.md hard rule 2).
- [ ] `refund` — restricted similarly, returns funds to payer. Tracked as
  issue #3 (includes its own tests).
- [ ] Full test suite in `contracts/escrow/tests/` covering: happy path,
  unauthorized release attempt, double-release attempt, refund after
  partial state — split across issues #2/#3 above rather than tracked
  separately, since AGENTS.md requires tests in the same PR as the logic.

## Phase E3 — TypeScript SDK
- [ ] `@docforum/escrow-sdk` wrapping `create_escrow`/`get_status`. Tracked
  as issue #4 (unblocked now that Phase E1 is merged). `release`/`refund`
  wrapping is a follow-up once issue #2/#3 land.
- [ ] Published to npm (or GitHub Packages — decide, record as an ADR in
  `docs/adr/`). Tracked as issue #5.
- [ ] Integration test against testnet from the SDK itself, not just the
  contract's own test suite.

## Phase E4 — Security review (blocking for any mainnet use)
- [ ] External or community review before any non-testnet deployment.
  Tracked as issue #6.
- [ ] Documented threat model in `docs/`. Part of issue #6.

## Explicitly out of scope for this repo
- Any healthcare-specific logic (see README).
- Fiat on/off-ramp, KYC — that's `docforum-core`'s concern if/when it
  builds general payments (see prior architecture discussion), not this
  repo's.

## Changelog
- 2026-09-09 — Repo created as part of the DocForum 3-repo org split.
- 2026-09-14 — Phase E1 implemented: `create_escrow`/`get_status` on
  `soroban-sdk` 27.0.6, 4 tests passing, wasm build verified. Testnet
  deploy intentionally left undone (needs a funded identity + CLI this
  environment doesn't have) — do not mark E1 fully done until that lands.
