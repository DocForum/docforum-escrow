# ROADMAP.md — docforum-escrow

> Update this file on every contribution that starts/completes/blocks an
> item below.

**Status: Phase E1 done. Phase E2 done (not yet redeployed to testnet — see note below). Phase E3's SDK scaffold in progress.**

## Phase E1 — Contract skeleton
- [x] Soroban project scaffold (`contracts/escrow`), builds to wasm
  (`cargo build --target wasm32v1-none --release`) — 4 passing tests in
  `contracts/escrow/tests/create_escrow.rs`.
- [x] Deploy to testnet as a no-op — **done 2026-09-14**. Contract
  `CABSYY5FZGCCZ3UTBQGC7S357D2FUFLUQUUGJCCFHKGEJZVIFK4SIS2Z`, verified live
  (not just deployed): `get_status` on an unknown id correctly errors, and
  a real `create_escrow` call locked 0.5 testnet XLM and reported
  `"Funded"` back. Full record, including the transaction links:
  `docs/testnet-deployments.md`. Closes issue #1.
- [x] `create_escrow` — locks funds (calls the SEP-41 token contract's
  `transfer`), assigns a sequential `escrow_id`, stores payer/payee/amount/
  opaque `condition_ref`, status `Funded`. Rejects non-positive amounts.
  Proven on testnet, not just in local tests — see above.
- [x] `get_status` — read-only status query, errors on unknown id. Proven
  on testnet, not just in local tests — see above.

## Phase E2 — Release & refund
- [x] `release` — restricted to the escrow's `releaser` (set at
  `create_escrow` time, decision recorded in `docs/adr/0002` — a
  per-escrow address, not a single contract-level admin), moves funds to
  payee, only while `Funded`. Closes issue #2.
- [x] `refund` — same auth/state rule, returns funds to payer. Closes
  issue #3.
- [x] Full test suite in `contracts/escrow/tests/release_refund.rs`: 7
  tests — release happy path, release unauthorized, double-release,
  refund happy path, refund unauthorized, refund-after-release,
  release-after-refund. 11/11 tests passing repo-wide (4 existing +
  7 new); wasm release build still succeeds.
- [ ] **Not yet done:** redeploy to testnet with the new (Phase E2)
  `create_escrow` signature (it gained a `releaser` param — see ADR
  0002 "Consequences") and exercise `release`/`refund` against a real
  testnet instance, not just the local test suite. The existing
  `docs/testnet-deployments.md` record is Phase E1-only and stays
  accurate as history; it is not being retroactively edited.

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
- 2026-09-14 — Phase E1 fully closed: deployed to testnet
  (`CABSYY5FZGCCZ3UTBQGC7S357D2FUFLUQUUGJCCFHKGEJZVIFK4SIS2Z`) via the
  `stellar` CLI, and verified live with a real `create_escrow` call (0.5
  testnet XLM, native SAC) followed by `get_status` confirming `"Funded"`.
  See `docs/testnet-deployments.md`. Issue #1 closed.
- 2026-09-14 — Added `.github/ISSUE_TEMPLATE/bug_report.md` (identical
  copy across all three org repos — see `docforum-core`'s changelog for
  the sourcing note: a user-supplied bug-report structure plus
  drips.network's "Creating Meaningful Issues" guide).
- 2026-09-14 — Replaced the placeholder `ci.yml` (`echo "TODO"`,
  `pull_request`-only, never once run — every commit so far went
  straight to `main`) with a real workflow: `cargo test` +
  `cargo build --target wasm32v1-none --release` against the actual
  contract in `contracts/escrow/`, triggered on both push to `main` and
  PRs, with a final check that the wasm artifact actually exists. SDK
  build/test intentionally left out of CI — `sdk/package.json`'s
  `build`/`test` scripts are still `echo TODO` placeholders (issue #4),
  nothing real to validate yet; add them to this workflow when #4 lands.
  Done ahead of a Drips Wave application: a reviewer or prospective
  contributor landing on this repo should see it actually exercising its
  own tests, not a stub.
- 2026-09-15 — General workspace-audit fixes (applied identically across
  all three org repos, see `docforum-core`'s changelog for the full
  rationale): added `CONTRIBUTING.md` (human onboarding — `AGENTS.md` is
  agent-facing, and this repo's contract moves real funds, so it also
  notes reporting security issues privately rather than as a public
  issue, ahead of the planned Phase E4 review); enabled branch protection
  on `main` (real CI check + 1 approval required to merge, force-push/
  deletion disabled, `enforce_admins` left `false` so the maintainer
  isn't blocked). Topics were already added in the prior session.
- 2026-09-15 — Implemented Phase E2: `release()` and `refund()`. Auth
  model decision recorded in `docs/adr/0002` — a per-escrow `releaser`
  address, set at `create_escrow` time, rather than a single
  contract-level admin (reasoning: no single point of control, matches
  who actually knows when to release/refund, stays generic per ADR
  0001, multi-tenant ready). This changed `create_escrow`'s signature
  (added `releaser: Address`) — a breaking change from the Phase E1
  signature already live on testnet; that deployment record stays as
  accurate history, not retroactively edited. 7 new tests in
  `tests/release_refund.rs` covering both functions' happy paths,
  unauthorized-caller rejection, double-release, refund-after-release,
  and release-after-refund. 11/11 tests passing, wasm release build
  verified. `ARCHITECTURE_ESSENTIALS.md` contract-surface table updated.
  Closes issues #2 and #3. **Not yet done:** redeploying to testnet with
  the new signature — Phase E2 is proven in the local test suite only
  so far, not live.

