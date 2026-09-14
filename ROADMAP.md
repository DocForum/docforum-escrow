# ROADMAP.md — docforum-escrow

> Update this file on every contribution that starts/completes/blocks an
> item below.

**Status: Not started.**

## Phase E1 — Contract skeleton
- [ ] Soroban project scaffold (`contracts/escrow`), builds and deploys to
  testnet as a no-op.
- [ ] `create_escrow` — locks funds, assigns an `escrow_id`, stores payer/
  payee/amount/opaque `condition_ref`.
- [ ] `get_status` — read-only status query.

## Phase E2 — Release & refund
- [ ] `release` — restricted to a designated releaser identity/role, moves
  funds to payee.
- [ ] `refund` — restricted similarly, returns funds to payer.
- [ ] Full test suite in `contracts/escrow/tests/` covering: happy path,
  unauthorized release attempt, double-release attempt, refund after
  partial state.

## Phase E3 — TypeScript SDK
- [ ] `@docforum/escrow-sdk` wrapping the three calls above + status query.
- [ ] Published to npm (or GitHub Packages — decide, record as an ADR in
  `docs/adr/`).
- [ ] Integration test against testnet from the SDK itself, not just the
  contract's own test suite.

## Phase E4 — Security review (blocking for any mainnet use)
- [ ] External or community review before any non-testnet deployment.
- [ ] Documented threat model in `docs/`.

## Explicitly out of scope for this repo
- Any healthcare-specific logic (see README).
- Fiat on/off-ramp, KYC — that's `docforum-core`'s concern if/when it
  builds general payments (see prior architecture discussion), not this
  repo's.

## Changelog
- 2026-09-09 — Repo created as part of the DocForum 3-repo org split.
