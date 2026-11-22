# ROADMAP.md — docforum-escrow

> Update this file on every contribution that starts/completes/blocks an
> item below.

**Status: Phase E1 done. Phase E2 done and live on testnet. Phase E3's `create_escrow`/`get_status`/`release`/`refund` wrapping done; SDK distribution decided (issue #5 closed — GitHub Release tarball, ADR 0003). Phase E4 (security review, issue #6) in progress: threat model drafted (`docs/threat-model.md`) and the timeout-refund item closed (issue #11 — ADR 0004 + implementation, live on testnet); independent review not yet done — blocking for any mainnet use. Phase E5 (contract features) now includes the OZ-library evaluation (ADR 0006, no library adopted) and the optional in-contract M-of-N releaser quorum (ADR 0007, SDK 0.5.0) — implemented, tested and pending a testnet redeploy. Phase E6 (npm publishing) in progress: automated `sdk-v*` release workflow with provenance, changesets, and a superseding ADR landed; the one-time human npm org/trusted-publishing setup is still pending, so `sdk-v0.3.0` is not yet on npm. Fee estimation and fee-bump sponsorship helpers (issue #70) are implemented in the SDK, `0.5.0`. Phase E7 (verification/release engineering) started: committed Soroban test snapshots with a CI drift check (issue #120) and a CI check that generated SDK bindings match the contract WASM (issue #121).**

## Payee acceptance (issue #25)

An opt-in creation method can require the payee to authorize `accept` before release. Existing escrows keep the default behavior, and refunds remain available without acceptance. Acceptance is recorded in the escrow data.

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
- [x] Redeployed to testnet with the new (Phase E2) `create_escrow`
  signature — **done 2026-09-15**. Contract
  `CAXESEEAJILFFCN3PH2HHNMWAAHLEB64UTJHZ6IP7C5BBICT3S3VODSM`, supersedes
  the Phase E1-only deployment (kept as history, not edited). Verified
  live: a real `release` (funds moved to payee), a real `refund` (funds
  returned to payer), and a real unauthorized-caller rejection
  (`Error(Contract, #3)`) — not just the local test suite. Full record:
  `docs/testnet-deployments.md`.

## Phase E3 — TypeScript SDK
- [x] `@docforum/escrow-sdk` wrapping `create_escrow`/`get_status`/
  `release`/`refund`. Closes issue #4. Originally scoped to wrap only
  `create_escrow`/`get_status` (`release`/`refund` didn't exist yet when
  #4 was written) — since Phase E2 landed in the same work session,
  wrapping all four now avoided shipping an SDK immediately stale
  relative to the contract it wraps.
  - `sdk/src/generated/contract-client.ts` — machine-generated via
    `stellar contract bindings typescript --wasm ...` against the local
    wasm build (not the live deployment, so it isn't stale relative to
    source). Never hand-edit; regenerate on contract signature changes.
  - `sdk/src/index.ts` — the actual public surface: an `EscrowClient`
    class accepting a `Keypair` directly as a signer (converted
    internally by `@stellar/stellar-sdk`'s `KeypairSigner`) — no manual
    XDR-signing plumbing exposed to consumers (e.g. `docforum-core`'s
    `payments` module).
- [x] Decided npm vs. GitHub Packages — closes issue #5. **Interim**:
  consumed via a tarball attached to a tagged GitHub Release
  (`sdk-v0.1.0`), not GitHub Packages — that registry requires auth even
  for public packages, which would break `npm ci` for any external Wave
  contributor's fork. (A git-subdirectory dependency was tried first as
  a zero-infrastructure option but doesn't actually work against this
  npm version — see ADR revision note.) Real npm registry publish is the
  long-term goal once publishing credentials exist (an out-of-band human
  step, same category as the Drips Wave application itself). Verified
  end-to-end: installed and imported successfully from
  `docforum-core/backend`. See `docs/adr/0003`.
- [x] Integration test against testnet from the SDK itself, not just the
  contract's own test suite. `sdk/tests/testnet-integration.test.ts` — 3
  tests, all passing against the live Phase E2 deployment: full release
  lifecycle, full refund lifecycle, unauthorized-caller rejection.
  Deliberately **not** wired into `npm test`/CI (`npm run
  test:integration` only) — depends on testnet + Friendbot funding
  liveness, a different reliability profile than this org's other
  "integration" tests (e.g. `docforum-core`'s self-contained embedded-
  Postgres booking test). CI runs `typecheck`+`build` only for the SDK.

## Phase E4 — Security review (blocking for any mainnet use)
- [ ] External or community review before any non-testnet deployment.
  Tracked as issue #6.
- [ ] Documented threat model in `docs/`. Part of issue #6. **In progress:**
  draft in `docs/threat-model.md` (self-written by the implementer, so it
  does not count as the review). Stays unchecked until an independent
  reviewer has gone through it.
- [x] Timeout refund path when the releaser key is lost — issue #11.
  Decided in `docs/adr/0004` (optional `refund_after` set at creation,
  after which **anyone** may refund, still only to `payer`; `release` is
  never gated by it; alternatives compared and payee implications for T8
  recorded), implemented in `contracts/escrow/src/lib.rs` with 17 tests
  in `contracts/escrow/tests/timeout_refund.rs` covering every edge case
  the issue lists. Breaking `create_escrow` change → SDK bindings
  regenerated, `@docforum/escrow-sdk` **0.3.0** (migration notes in ADR
  0004), redeployed to testnet and verified live
  (`docs/testnet-deployments.md`, 2026-10-08 entry). Closes issue #11.
  The threat model's §6 checklist item for this is checked; the
  operational half of T2 (key backup / multisig releaser) remains open.
- [x] Balance-delta check on `create_escrow` + malicious mock-token
  tests (issue #12). The contract's token balance must rise by exactly
  `amount` across the funding transfer or the escrow is rejected with
  `BalanceMismatch` (error code 6) — a lying transfer, fee-on-transfer, or
  rebasing token would otherwise create `Funded` escrows backed by
  nothing (threat model T5). Three test-only mock tokens in
  `tests/malicious_token.rs`: lying transfer, short delivery (debits
  300, delivers 270), and one that re-enters `release` from inside
  `transfer` (T4). The re-entry test pinned the actual host behavior:
  Soroban rejects re-entry as an unrecoverable context error ("Contract
  re-entry is not allowed"), aborting the whole invocation — fail-closed.
  Post-creation clawback remains possible by design and is documented in
  T5 as accepted residual risk. Deployed and verified with a real
  fee-on-transfer rejection on testnet; see `docs/testnet-deployments.md`.
  Closes issue #12.
- [x] Redeploy current upstream `main` to testnet with live create, release,
  refund, timeout-refund, and `BalanceMismatch` verification (issue #109).
  The current contract ID and transaction links are in
  `docs/testnet-deployments.md`; prior deployment records remain as history.
- [ ] Releaser-key compromise runbook and race-to-settle tooling (issue #94).
  `docs/runbooks/releaser-compromise.md` (linked from threat model T1) and the
  resumable `scripts/settle-outcomes.py` are in; the 50+ escrow testnet drill
  has not been run or recorded yet.
- [ ] Rest of the `docs/threat-model.md` §6 pre-mainnet checklist, scoped
  into issues: [#8](https://github.com/DocForum/docforum-escrow/issues/8) write status before transfer + reject
  contract-self addresses (Trivial), [#9](https://github.com/DocForum/docforum-escrow/issues/9) events (Medium — **done**,
  see `contracts/escrow/tests/events.rs` and `ARCHITECTURE_ESSENTIALS.md § Events`),
  [#10](https://github.com/DocForum/docforum-escrow/issues/10) storage TTL (Medium — **done**, see `contracts/escrow/tests/ttl.rs` and `ARCHITECTURE_ESSENTIALS.md § Storage TTL & Archival`), [#15](https://github.com/DocForum/docforum-escrow/issues/15) integrator trust-model
  docs (Trivial).
- [x] Integrator trust-model docs (issue #15): added a "Trust model for
  integrators" section to `README.md` covering T8, T5, T9 and the
  caller-supplied `contractId`, plus `condition_ref` privacy warnings on
  `EscrowData`/`create_escrow` in the contract and `createEscrow` in the SDK.
  Docs only — no behavior change.
- [ ] Related, not in the checklist: [#13](https://github.com/DocForum/docforum-escrow/issues/13) `get_escrow`
  full-record read (Medium), [#14](https://github.com/DocForum/docforum-escrow/issues/14) offline SDK unit tests in CI
  (Medium).

## Phase E5 — Releaser custom account
- [x] Optional M-of-N Soroban custom releaser account (issue #50):
  `contracts/releaser-account/` verifies distinct Ed25519 signatures,
  restricts authorization to one `release`/`refund` call on its configured
  escrow, and requires the current threshold for nonce-bound signer and
  threshold changes. Design is in `docs/adr/0005-custom-releaser-account.md`
  and the T1 update in `docs/threat-model.md`. Not deployed to testnet; this
  does not change the escrow contract or make mainnet use permissible.
- [x] Custom releaser account rotation (issue #302): the account may authorize
  `rotate_releaser` for its configured escrow when the payer also authorizes;
  rotation consumes one per-window operation slot and is covered by unit and
  end-to-end tests. See ADR 0005.

## Phase E5 — Bound condition_ref length and validate it at creation
- [x] Pick a maximum length (64 bytes) based on observed integrator usage
  (UUIDs, short labels; existing test refs far shorter), document the
  rationale, and reject longer refs with a new error code
  (`ConditionRefTooLong = 7`) at creation — closes issue #57.
- [x] Update the SDK to validate the same bound client-side with a shared
  constant (`MAX_CONDITION_REF_LENGTH`), so callers fail fast instead of
  paying network fees for a rejected transaction.
- [x] Update T10 in `docs/threat-model.md` with the bound and rationale,
  and update `README.md` + `ARCHITECTURE_ESSENTIALS.md` to surface the
  new contract/SDK surface. Contract tests added in
  `contracts/escrow/tests/create_escrow.rs` (hard rule 2).
- [x] Redeployed to testnet with `ConditionRefTooLong` on 2026-10-20;
  lifecycle and `BalanceMismatch` verification are recorded in
  `docs/testnet-deployments.md`.
## Phase E5 — Contract features

- [x] Split one escrow release across up to eight unique payees (issue #22, ADR 0014): positive basis-point shares total 10,000; fees are taken first, then rounding dust goes to the final payee. Tests: contracts/escrow/tests/split_payouts.rs. Not yet on testnet.
- [x] Batch release and refund (issue #29, `docs/adr/0012`): `settle_many(caller, ops: Vec<(escrow_id, Release|Refund)>)`, best-effort with one result per op, per-op auth against each escrow's own releasers, at most `MAX_SETTLE_OPS` = 20 (measured against the 16 KiB events budget). T1 response guidance updated. Tests: `contracts/escrow/tests/settle_many.rs`. **Not yet on testnet.**
- [x] Per-token liability accounting and an on-chain solvency view (issue #39): `solvency(token) -> (balance, liabilities)`; the counter moves in the same invocation as every value-moving state change and its TTL is extended on each write. Property test: `contracts/escrow/tests/liabilities.rs`. Monitoring guidance in `docs/threat-model.md`. **Not yet on testnet.**
- [x] Optional escrow-wide earliest release time (issue #43, ADR 0009); refund path remains independent.
- [x] Two-party releaser rotation (issue #23): current releaser and payer authorize; only funded single-releaser escrows can rotate. Contract and payee addresses are rejected.
- [x] Releaser-authorized split settlement (issue #46): a single releaser may pay a chosen amount to the payee and return the remainder to the stored refund destination; configured release fees remain accounted for.
- [x] Fixed-total linear vesting streams with payee withdrawals and vested/unvested refund settlement (issue #44, ADR 0012).
- [x] Undeliverable payee handling (issue #55): a rejected outbound release transfer (deauthorised SAC trustline, rejecting contract payee) returns append-only `Error::Undeliverable = 35` and leaves the escrow `Funded`, so the releaser can retry or refund. Tests: `tests/undeliverable.rs`.

- [x] **OpenZeppelin Stellar library evaluation** (issue #118) —
  `docs/adr/0006`: all six candidate modules checked against ADR 0001/0002
  and the "no hidden admin" rule. Pausable, Upgradeable and the
  access/role modules are **rejected** (each adds a contract-level role,
  and a pause switch would let its holder block every release and timeout
  refund); smart-account/multisig-account modules stay out of scope; no
  stable OZ release supports this contract's `soroban-sdk` major (0.7.2
  requires `^26.1.0`, this contract pins 27.0.6). **Adopted:** the audited
  checks-effects-interactions ordering (T4) implemented directly in
  `settle()` — status written before the outbound transfer, with a
  rollback test (`tests/malicious_token.rs::failed_payout_leaves_the_escrow_funded`).
  Library pinning/update policy and the wasm/instruction-cost comparison
  recorded in the ADR. **Not yet on testnet.**
- [x] **In-contract M-of-N releaser quorum** (issue #119) —
  `docs/adr/0007`: optional `create_escrow_with_releasers(releasers,
  threshold)` (1–10 addresses, threshold 1..=len, no duplicates) plus
  `release_with_approvals`/`refund_with_approvals`. Approvals are collected
  **in one call** (each approver authorizes that exact invocation) rather
  than accumulated, so there is no approval state to clear and nothing to
  replay; duplicates are rejected and never count twice. `EscrowData` now
  stores `releasers` + `threshold` (single-releaser escrows are stored as
  1-of-1, entry points unchanged); `release`/`refund` on a quorum escrow
  return `ThresholdNotMet`. Timeout refunds stay open to anyone. New
  append-only errors 13–17. 19 tests in `tests/quorum.rs`; single-releaser
  suites unchanged and green. Breaking read shape → SDK 0.5.0, bindings
  regenerated. **Not yet on testnet** — the live deployment predates it.
- [x] **Payer cancel before the payee accepts** (issue #27) —
  `docs/adr/0010`: `cancel(escrow_id, payer)`, allowed only while `Funded`,
  on an escrow with `requires_acceptance`, and before the payee's
  `accept`. Reuses #149's `requires_acceptance`/`accepted_at` and `settle()`
  (checks-effects-interactions), so funds go to the stored `refund_to`
  (#158) and I1 is unchanged. New terminal `EscrowStatus::Cancelled`; no new
  error codes. Tests: `tests/cancel.rs`, including both orderings of
  accept vs cancel in one ledger, sponsored `refund_to`, and `top_up`
  interaction. SDK `client.cancel(...)`; bindings regenerated; 0.6.0 →
  0.7.0. **Not yet on testnet** — the live deployment predates it.
- [x] Sponsored funding: a funder distinct from the refund recipient —
  issue #28. **ADR first:** `docs/adr/0009` answers the two questions the
  issue poses — a separate refund destination **is** compatible with
  invariant I1 (it is a second address stored at creation and read, never
  supplied, at payout), and it is authorised by the **funder** in their
  existing `create_escrow` signature (Soroban auth covers all arguments;
  the recipient only receives and need not sign). **Implementation:**
  optional `refund_to` on `create_escrow`, `create_escrow_with_acceptance` and `create_escrow_with_releasers` (default `payer`, so omitted =
  unchanged), stored in `EscrowData`, used by every refund path (releaser
  and timeout share one transfer; payee-initiated voluntary refunds (issue
  #40, ADR 0010) also use the same stored `refund_to` destination), rejected with
  new `Error::InvalidRefundTo = 21` if it is the contract itself.
  **Tests:** 16 in `contracts/escrow/tests/sponsored_refund.rs` — releaser
  refund, timeout refund (stranger, funder, exactly at the deadline), no
  authority from being funder/recipient, release unaffected, default
  unchanged, contract-self rejected, funder auth required, recipient never
  signs. **I1 wording** updated in `docs/threat-model.md` (plus actors, T1,
  T2, T8, new T21 and §6). **Breaking change:** `create_escrow` gains a
  parameter and `EscrowData` a field; `@docforum/escrow-sdk` 0.5.0 →
  0.6.0 (bindings regenerated, never hand-edited; adds `refundTo` on
  `createEscrow` and `getEscrow`). The current contract was deployed on
  testnet 2026-10-20 and the SDK tests target it. Publishing the
  `sdk-v0.6.0` release tarball per ADR 0003 remains pending.
- [x] Immutable deploy-time token allowlist (issue #36):
  `__constructor(allowed_tokens)` stores approved addresses;
  `create_escrow` rejects unlisted tokens with append-only error code 7.
  An empty list preserves allow-all behavior. Tests cover listed,
  unlisted, and empty-list cases. Threat model, deployment guidance, and
  contract API docs updated. Deployed and verified with the immutable
  testnet allowlist on 2026-10-20. Closes issue #36.
- [x] Optional release callback (issue #53): both single-releaser and
  quorum creation require payee authorization when `notify_payee` is true;
  release calls `on_escrow_released` after transfer and rolls back atomically
  on failure. Re-entry tests cover release/refund/create attempts. ADR 0005
  and threat-model T11 document the decision. Deployed on testnet
  2026-10-20.
- [x] Optional protocol fee taken at release, with recipient and bps fixed
  at creation — issue #30. `docs/adr/0010`: an optional
  `fee_recipient`/`fee_bps` pair (atomic — a half-set pair is rejected),
  capped at 10 % (`MAX_FEE_BPS = 1_000`), taken **off the top** at release
  — `⌊amount × fee_bps ÷ 10 000⌋` to `fee_recipient`, the exact remainder
  to `payee` (floor rounding, so fee + payout always equal the stored
  `amount`) — and **never** on `refund`, which still returns the full
  `amount`. `fee_recipient` may not be the escrow contract itself.
  Both fields are readable from `get_escrow` before funds are locked.
  `create_escrow` and `create_escrow_release_time` take the pair; the
  acceptance and M-of-N entry points remain fee-free. `top_up` grows the
  escrowed amount and therefore the bps fee, re-checking the fee math
  before its transfer. New append-only `Error::InvalidFee = 35`, new
  invariant I7, 17 tests in `tests/protocol_fee.rs`. Breaking read shape
  and creation signature → SDK minor changeset and regenerated bindings.
  **Not yet on testnet** — the live deployment predates the fee.
- [x] Emergency pause that can only stop new deposits — issue #35.
  `docs/adr/0011`: one `pause_admin` address fixed at deployment by
  `__constructor(allowed_tokens, pause_admin)`, which may `pause`/`unpause`
  a flag that blocks **every deposit path** — `create_escrow` and its
  variants (they share `create_escrow_inner`), `top_up`, and the pooled
  `create_pooled_escrow`/`contribute` — and nothing else. `release`,
  `refund`, the timeout refund and pooled `claim_refund` never read it, so a
  pause can never lock existing funds (invariant I8, threat model T12).
  Alternatives rejected in the ADR: permissionless pause (trivial
  griefing), auto-expiring pause (silently lapses mid-incident), token
  allowlist (a different problem), and doing nothing. New error codes
  `Paused`, `AlreadyPaused` and `NotPaused`, with codes
  38–40 (contract 2.5.0);
  `Paused`/`Unpaused` events carry the custodian. 20 tests in
  `contracts/escrow/tests/pause.rs`, including release, releaser refund,
  stranger timeout refund, and release-after-deadline while paused, plus a
  year-long pause leaving nothing stuck, `top_up` blocked, and pooled
  contributions blocked while pooled claims and releases still pay out. SDK minor
  changeset with `pause`/`unpause`/`isPaused`/`getPauseAdmin` and
  regenerated bindings. Not yet redeployed to testnet — the current
  deployment predates the constructor and cannot pause.
- [ ] Redeploy to testnet with the new constructor (`allowed_tokens`,
  `pause_admin`) and verify `pause`/`unpause` live, including a release
  while paused.
- [ ] Decide the mainnet custodian: a Stellar multisig account (2-of-3)
  held in a KMS/HSM — no contract change needed, it is the deploy-time
  `pause_admin` argument (threat model T12).
- [x] **Pooled escrows funded by multiple payers** (issue #113) —
  `docs/adr/0011`: open contributions until an explicit
  `funding_target` (fixed contributor list rejected — see ADR table),
  bounded by a `funding_deadline`. New entry points
  `create_pooled_escrow` / `contribute` / `claim_refund` / `get_pooled` /
  `get_contribution`; `EscrowData` and all existing entry points
  unchanged (pooled records live under two appended storage keys).
  `contribute` is permissionless before the deadline, delta-verified via
  the existing `transfer_in_exact`, recorded per payer (repeats
  accumulate), and rejects overfunding. `release` additionally requires
  `funded == target`, so partial pools never release. A missed deadline
  opens **pull-based** refunds: each contributor claims their exact
  recorded amount once, independently — no contributor iteration
  anywhere, no contributor cap by design (ADR 0011 "Resource limits").
  Push `refund`/`refund_with_approvals`/`cancel`/`top_up` reject pooled
  escrows (append-only errors 26–34). Threat model: I1–I4 generalized,
  new T16–T19 + traceability rows. Tests: 18 in `tests/pooled.rs`
  (scenarios A–M) + 3 malicious-token contribution tests; existing
  suites and snapshots unchanged. SDK `0.7.0 → 0.8.0` (additive).
  **Not yet on testnet** — the live deployment predates it.

- [x] Payee rights transfer (issue #45): `transfer_payee(escrow_id,
  current_payee, new_payee)` lets the current payee reassign the release
  destination to a new address while the escrow is `Funded`. Only the
  current payee may authorise this call — the payer and releaser have no
  power to redirect funds via this path. `new_payee` may not be the
  contract's own address (would permanently lock funds) or the payer
  (would let a colluding payee redirect a release to the payer, bypassing
  refund auth). Emits a `pay_xfer` event. This is a rotation tool: a
  payee who has already lost their key cannot use it (they cannot sign).
  Key loss remains an operational risk the payee must mitigate off-chain.
  12 tests in `contracts/escrow/tests/transfer_payee.rs` covering the
  happy path, release/refund after transfer, chained transfers,
  auth rejection for stranger/payer/releaser, and both rejected
  `new_payee` targets. Rejected with `Error::InvalidNewPayee`.
  Threat model
  I1 updated; T22 added covering the new payee-key attack surface.
  `ARCHITECTURE_ESSENTIALS.md` contract surface updated.
  Closes issue #45.
- [x] **Reclaim storage for settled escrows** (issue #48) —
  `docs/adr/0013`: keep only the existing `Status` entry, chosen over delete / keep-everything. Every
  terminal transition of an ordinary escrow goes through `settle()`, which
  removes the persistent `EscrowData` (the `Status` entry stays), then publishes
  the existing `ESCROW` state event. `get_status`
  answers for settled ids (`NotFound` now means "never created"),
  `get_escrow` is funded-only, and mutating calls on a settled id still return
  `NotFunded`. Measured: the 628-byte record is reclaimed per settled escrow; a 28-byte `Status` entry remains. Pooled
  escrows are not reclaimed (ADR 0011 reads their record after settlement).
  Known gap: the state event omits `refund_to` and `release_not_before`;
  widening it breaks the indexer's fixed 12-field decoder, so it is a
  separate change. SDK minor, `getEscrow()` breaking for settled ids.
  **Not yet on testnet** — needs a redeploy.
- [x] Quorum releaser rotation (issue #294, ADR 0009): `rotate_releaser_with_approvals(escrow_id, approvers, old, new)` replaces one member of an M-of-N set with `threshold` approvals plus the payer's consent; the outgoing member's approval counts. Tests: `contracts/escrow/tests/releaser_rotation.rs`.
- [x] Read-only token allowlist getter (issue #299): `get_allowed_tokens()`
  returns the immutable deploy-time allowlist as `Vec<Address>`; an empty
  list still means any token. Two tests in
  `contracts/escrow/tests/token_allowlist.rs` cover the configured and empty
  cases. SDK `getAllowedTokens()` and regenerated bindings. No new storage
  key or error code.
- [x] List escrows by payer or payee (issue #33, ADR 0015): decided **off-chain**, so the contract is unchanged. The `ESCROW` event (issue #9) already carries `payer`/`payee`, and the issue #87 indexer already stores them, so the query is an index filter; `EscrowIndexerClient.listEscrows` gained optional `payer`/`payee` filters. No redeploy; SDK minor, additive.

## Phase E6 — SDK & integrator tooling
- [x] Typed SDK errors mapped from the contract error enum (issue #61):
  named classes for each current contract error and distinct simulation,
  submission, timeout, and network mismatch errors. The generated mapping
  is checked in CI against `contracts/escrow/src/lib.rs`; unknown future
  codes remain generic `ContractError` instances and causes are preserved.
  Consumer migration guidance: `docs/sdk-errors.md`.
- [x] Escrow lifecycle snapshots and a configurable SubQuery indexer with a typed, paginated SDK query client (issue #87). Operators provide the deployed contract and starting ledger; no hosted indexer is assumed.
- [x] **Prepare / sign elsewhere / submit** (issue #58): `prepareCreateEscrow`
  builds and simulates an unsigned `create_escrow` for a public key (no secret),
  bounded by ledger bounds (`validUntilLedger`); `submitSigned` verifies the
  hash, expiry and source sequence, optionally fee-bumps under a hard cap, and
  polls to completion. Typed `PreparedTransactionExpiredError`,
  `StaleSequenceError`, `SignedTransactionMismatchError`. SDK minor, additive.
- [x] **Offline prepare / submit for release and refund** (issue #59):
  `prepareRelease` / `prepareRefund` return an unsigned envelope for cold keys
  and classic multisig releasers (about a one-day window); `mergeSignatures`
  combines separately signed copies of one transaction; `signAuthEntries`
  covers a hot fee payer with a cold releaser. `submitSigned` detects sequence
  staleness and expiry. Air-gapped example in `examples/offline-release/`.
  SDK minor, additive.
- [x] Automated npm release workflow (`.github/workflows/release-sdk.yml`),
  triggered by an `sdk-v*` tag: builds, typechecks, tests, runs
  `npm publish --provenance`, and attaches the tarball to the GitHub
  Release (kept for existing consumers per ADR 0003). Uses npm trusted
  publishing (OIDC, `id-token: write`) so no long-lived token sits in
  secrets; refuses to publish if the tag doesn't match `package.json`'s
  version. Closes issue #16.
- [x] Adopted changesets (`.changeset/`, `@changesets/cli`) for version
  bumps and changelogs; `sdk/package.json` gained `changeset`/
  `version`/`release` scripts and `publishConfig` with provenance.
- [x] Superseding ADR written: `docs/adr/0005` supersedes ADR 0003's
  interim tarball-only decision now that npm publishing is going live.
- [ ] One-time human steps (npm org creation, trusted-publisher setup for
  the release workflow) — documented in `CONTRIBUTING.md`; not yet done,
  so `sdk-v0.3.0` is not yet published to npm.
- [x] Fee estimation and fee-bump sponsorship helpers (issue #70).
  `estimate({ source, method, args })` simulates a call and returns
  `resourceFee` (with a 20% buffer over the simulated minimum, rounded
  up), `inclusionFee`, `total`, and the raw `minResourceFee`, in stroops.
  `feeBump(signedXdr, sponsor, { maxFee, baseFee? })` wraps a signed
  envelope and charges `baseFee × (inner operations + 1)`; it throws
  `MaxFeeExceededError` before building anything when that exceeds
  `maxFee`, so a fee spike can never silently overshoot the cap.
  `guardSponsorship` / `assertSponsorable` inspect **every** operation
  and every contract-address auth entry, rejecting foreign contract
  calls, non-invocation operations, foreign auth targets, and
  already-bumped envelopes while allowing the account auth entries a
  legitimate escrow call carries. 17 offline unit tests in
  `sdk/tests/fees.test.ts` (wired into CI as `npm run test:unit`) plus a
  live-testnet estimate/fee-bump case in `testnet-integration.test.ts`;
  additive SDK surface, `0.4.0 → 0.5.0`. Closes issue #70.
- [x] React hooks package (issue #126) — `packages/escrow-react`,
  published name `@docforum/escrow-react`. TanStack Query v5 peer.
  `useEscrow(id)` polls `getEscrow` and stops at `Released`/`Refunded`;
  `useEscrowActions(signer)` invalidates the query after a settlement and
  resolves wallet rejection as `{ status: "rejected" }`; `useEscrowTimeline`
  counts down to `refundAfter` with a documented ledger-vs-local clock
  caveat. Hooks only — no UI. 14 React Testing Library tests with a fake
  client and a dedicated CI job. Demo in `examples/web-demo/`.
- [x] Stellar Wallets Kit adapter (issue #127) —
  `WalletsKitSigner` on the `@docforum/escrow-sdk/signers/wallets-kit`
  subpath, implementing the SDK's SEP-43 `Signer` surface. The kit is an
  optional peer dependency and is injected, so there is no runtime import and
  server bundles stay wallet-free. Typed `WalletNetworkMismatchError` before
  signing; user rejection returned as SEP-43 `-4` rather than thrown. 12
  offline fake-kit tests.
- [x] Go client SDK (issue #128) — `sdk-go/`, module
  `github.com/DocForum/docforum-escrow/sdk-go`. `CreateEscrow`, `GetStatus`,
  `GetEscrow`, `Release`, `Refund` (+ `TopUp` and approval paths), typed
  contract errors, `big.Int` i128 amounts, offline unit tests and an opt-in
  quickstart integration suite with its own CI workflow.
- [x] OpenTelemetry instrumentation hooks (issue #129) — optional
  `instrumentation`/`onEvent` on `EscrowClient`, spans for `simulate`,
  `sign`, `submit` and `confirm`. No tracer/observer means no clock read and
  no span allocation. Attributes carry contract id, function, escrow id,
  transaction hash and retry count; addresses are opt-in only
  (`includeAddresses: true`). 7 offline tests assert span production and the
  disabled path.
- [x] Token-aware amount parsing and formatting (issue #81) —
  `sdk/src/amounts.ts`: `getTokenInfo(token)` reads `decimals`, `symbol` and
  `name` from the SEP-41 token contract (cached per contract address);
  `parseAmount` and `formatAmount` convert between human strings and raw
  `bigint` with strict validation (no floats/exponents, no excess fractional
  precision, no negatives, locale-independent). Property tests assert
  `format(parse(x)) == normalise(x)`. Used in the web demo and SDK docs.
- [x] Network presets with an explicit mainnet opt-in guard (issue #67) —
  `networks.testnet`, `networks.futurenet`, `networks.local` presets carry
  an RPC URL, network passphrase and known contract ids. Constructing a
  client with the mainnet passphrase throws unless `allowMainnet: true` is
  passed; custom networks (private quickstart) remain possible. With a
  preset (or `verifyNetwork: true`) the RPC's `getNetwork` passphrase is
  verified lazily, once, before the first network call (never in the
  constructor, cached per client), so a custom `rpcUrl` cannot bypass the
  guard. Offline unit tests cover each guard. Additive SDK surface (minor
  changeset).
- [ ] SDK lifecycle amendments (issue #84). Done: `topUp`, `accept`,
  `cancel` (now `EscrowSigner`), `createEscrow({ requiresAcceptance })`,
  typed `EscrowPreconditionError` checks before submission, and a
  `prepareLifecycleCall` → `signLifecycleCall` → `submitLifecycleCall` flow
  for parties on different machines. SDK `0.7.0 → 0.8.0`. Waiting on the
  contract: `extendRefundAfter` (#41) and `refundByPayee` (#40) need their
  contract functions merged first.
- [x] Published API reference (TypeDoc) and runnable examples (issue #79).
  `sdk/typedoc.json` generates an HTML reference for every exported symbol and
  enforces a missing-doc lint (undocumented exports, broken doc links and
  unexpected non-exported types fail `npm run docs`); a new `sdk/examples/`
  directory has one runnable, secret-free script per major flow
  (create/release, timeout refund, M-of-N quorum, and the estimate →
  prepare/sign → guard → fee-bump → submit sponsorship flow). CI type-checks
  the examples and builds the reference; a `docs` workflow publishes it to
  GitHub Pages (Pages enablement is a one-time human step). Docs-only — no
  contract or SDK API change, so bindings and the SDK version are unchanged.
- [x] Python client SDK (issue #68) — `sdk-python/`, package
  `docforum_escrow` on `stellar-sdk` 17. `create_escrow`, `get_status`,
  `get_escrow`, `release`, `refund`, one typed `ContractError` subclass per
  contract error code (named like the TS SDK's), `int` i128 amounts with range
  checks, offline unit tests in `.github/workflows/sdk-python.yml`, and an
  opt-in live testnet suite kept out of CI. Not on PyPI; publish plan in
  `sdk-python/README.md`.
- [x] Solvency checker (issue #78): `checkSolvency({ contractId, tokens })` returns balance vs liabilities per token from the on-chain `solvency` view, with an events-based fallback for deployments that predate it, and a `check-solvency` CLI command that exits 1 on a shortfall. Read-only, no secret needed.

## Phase E7 — Verification, testing & release engineering
- [ ] Assert exact auth trees throughout contract tests (issue #105). This contribution strengthens `create_escrow`, `release`, and `refund` with complete tree comparisons and a wrong-signer creation regression; remaining contract-test modules still need conversion.
- [x] Contract version and reproducible build provenance exposed in the
  contract interface and WASM metadata (issue #52).
- [x] **Storage and resource optimisation guided by benchmarks (issue #98)** — `get_status` reads a dedicated persistent status value instead of decoding `EscrowData`. Benchmarks showed that moving `NextId` to persistent storage raised creation costs, so it remains in instance storage. The added status record improves `get_status` while adding writes to creation and settlement. Storage layout changed, so deploy as a new testnet contract ID under ADR 0005 and let existing escrows settle on their original contract.
- [x] **Coverage-guided contract fuzzing (issue #99)** — `contracts/escrow/fuzz/` runs randomized create/release/refund sequences with ledger timestamp jumps against the Soroban test environment and checks payout, status, and balance invariants after each operation. CI runs a short cargo-fuzz pass on pull requests and a longer nightly pass, uploading crash artifacts. The committed seed corpus starts the lifecycle and timeout paths. No contract or SDK behavior changed.
- [x] **Reproducible WASM builds and deployment verification (issue #91)** ?
  Rust 1.96.0 and Stellar CLI 28.1.0 are pinned; the pinned
  `rust:1.96.0-bookworm` container compares release WASM hashes from two
  checkout paths after remapping repository paths. `contract-v*` releases
  publish the WASM and SHA-256 checksum. `scripts/verify-deployment` fetches
  deployed WASM from testnet and compares it with a local build; README
  documents third-party verification. No `stellar contract optimize` step is
  used. The current testnet deployment predates this source, so the verifier
  reports the expected hash mismatch. Contract tests/build and the two-path
  comparison passed locally.
- [x] **PR malware scan** — `.github/workflows/pr-malware-scan.yml` + `.github/scripts/pr-malware-scan.cjs`, on every PR push. Flags editor/devcontainer autorun tasks, npm install hooks, typosquatted packages and Actions, non-registry dependency sources, payloads disguised as fonts/images, base64/whitespace obfuscation, exfiltration endpoints, reverse shells and miners. HIGH findings fail the `Malware scan` check, label the PR `security-review` and @mention the author; one comment per PR, updated in place. Reads the PR as data only (never checks out or runs it). Added 2026-10-20 after a VS Code autorun payload (escrow #163) and a typosquatted action (escrow #176). Manual backfill (Actions → PR malware scan → Run workflow, `prs: all`) scans PRs opened before the scanner and records a `Malware scan` commit status, which satisfies the required check.
- [x] **Nightly testnet escrow lifecycle soak** (issue #108) —
  `.github/workflows/nightly-testnet-soak.yml` runs the SDK live integration
  suite nightly with generated identities, transient Friendbot retries,
  release/refund paths, and a short timeout refund. Quorum coverage remains
  skipped until the documented testnet contract supports it. Failures
  update one tracking issue in place and classify contract-missing resets,
  infrastructure failures, and SDK test failures. Manual dispatch includes
  a forced-failure reporting check.
- [x] **Commit Soroban test snapshots, review event/storage diffs in PRs**
  (issue #120) — `test_snapshots/` is no longer git-ignored; every
  `cargo test` writes one snapshot per test (events, auth, ledger/storage)
  and CI fails if the committed files change without being committed. The
  snapshots were reviewed once on the initial commit. Documented
  event-capture caveat: the SDK clears the event buffer at the start of
  every top-level invocation, so a snapshot only shows the events of a
  test's *last* contract call — `tests/top_up.rs::top_up_emits_an_event`
  deliberately ends on the emitting call so the mechanism is visible in a
  diff. Determinism verified by running the suite twice against the
  committed files (no diff).
- [x] **CI check that generated SDK bindings match the contract WASM**
  (issue #121) — `scripts/check-generated-bindings.sh` plus the `sdk-bindings`
  CI job: builds the WASM, regenerates with the Stellar CLI version pinned in
  `scripts/stellar-cli-version` (28.1.0, release tarball checksum pinned
  too), and fails with regeneration instructions if
  `sdk/src/generated/contract-client.ts` differs. Detects both a stale
  binding after a contract change and a hand edit; CI never commits the
  regeneration. Instructions in `sdk/src/generated/README.md`; the
  previously stale committed bindings (missing `top_up`, errors 6–8) were
  regenerated here.
- [x] **PR conflict notifier** — `.github/workflows/pr-conflict-notifier.yml` + `.github/scripts/pr-conflict-notifier.cjs`. On every push to `main` (and every 3h) it labels open PRs that conflict with `main` as `needs-rebase` and @mentions the author once per push with rebase steps; the label clears itself when the conflict is resolved. Runs from `main` only and never checks out PR code.
- [x] Property-based state-machine tests with proptest (issue #64).
  Pure-Rust reference model of the escrow state machine in
  `contracts/escrow/tests/model.rs` — no Soroban types, intentionally simple
  enough to review independently. A proptest state machine generates
  operation sequences (create/release/refund/timeout-refund) and compares
  contract results and stored state against the model after every step,
  including auth outcomes (who may call what, when). Shrunk failures
  print a readable operation sequence. CI runs a bounded case count
  (`PROPTEST_CASES`); a nightly workflow runs a larger count. Closes
  issue #64.
- [x] **TLA+ escrow state-machine model** (issue #112) — `spec/Escrow.tla` + `spec/Escrow.cfg` model the actual escrow lifecycle, status transitions, timeout refund behavior, payee acceptance, and same-ledger race windows while explicitly omitting unsupported disputes/milestone logic. TLC verification passed against the committed model.
- [x] **Scripted, deterministic deployment with records** (issue #89) —
  `scripts/deploy` builds or takes the WASM, checks its hash, uploads,
  deploys with the constructor allowlist, confirms the on-chain WASM, runs
  scripted live verification (create, release, refund, three rejection
  cases) and records the result in `deployments.json`,
  `docs/testnet-deployments.md` and the SDK (`knownContractId`,
  `knownNetworkConfig`). Refuses a dirty tree and mainnet; `--dry-run`
  targets a local quickstart.
- [x] **Contract interface snapshot and breaking ABI guard** (issue #96) — committed `contract-spec.json` snapshot of public functions, signatures, and error codes; CI diff ensures no unreviewed interface drift; error codes are checked append-only (never renumbered or reused); interface changes are classified as additive or breaking, requiring semver bump notes.

## Explicitly out of scope for this repo
- Any healthcare-specific logic (see README).
- Fiat on/off-ramp, KYC — that's `docforum-core`'s concern if/when it
  builds general payments (see prior architecture discussion), not this
  repo's.

## Changelog

> New entries go in `changelog.d/`, one file per PR — see
> `changelog.d/README.md`. Maintainers fold them in here with
> `node scripts/fold-changelog.mjs`. Please don't append to this section
> directly.

- 2026-10-19 — Issue #70 (Phase E6): added `estimate`, `feeBump`,
  `guardSponsorship` and `assertSponsorable` to the SDK. Estimation runs
  through the client's RPC and reports the resource fee with a buffered
  20% headroom, the inclusion fee, the total, and the unbuffered minimum;
  the buffered figure rounds up so an estimate is never a strop short.
  Fee-bumping refused to guess like the original branch did: it builds the
  fee-bump with `TransactionBuilder.buildFeeBumpTransaction`, charges
  `baseFee × (inner operations + 1)` (the inner fee is refunded), and
  checks the cap **before** building, throwing `MaxFeeExceededError`
  instead of overshooting. The sponsorship guard inspects every operation
  and every contract-address auth entry — an early draft compared *account*
  auth addresses to the contract and would have rejected legitimate
  payer/releaser entries — and unwraps (then rejects) an already-bumped
  envelope. 17 offline unit tests in `sdk/tests/fees.test.ts`, wired into
  CI as `npm run test:unit`, plus an estimate/fee-bump case against the
  live testnet deployment; additive surface, `0.4.0 → 0.5.0`. README,
  `ARCHITECTURE_ESSENTIALS.md` and this roadmap updated. Closes issue #70.
- 2026-10-20 — Added the Phase E7 nightly testnet soak workflow for issue
  #108, with transient Friendbot retries, fresh test identities, timeout
  refund coverage, failure classification, de-duplicated issue reporting,
  and a manual forced-failure path.
- 2026-10-19 — Required payee authorization when `notify_payee` is enabled,
  and extended the callback to quorum escrows after #203 introduced M-of-N
  releasers. Updated ADR 0005, T11, API docs and generated bindings.
- 2026-10-20 — Phase E5 + E7 batch (issues #118, #119, #120, #121).
  **#118:** ADR 0006 evaluates OpenZeppelin's Stellar contracts library;
  pause/upgradeable/access are rejected (contract-level roles, and a pause
  switch would gate releases and timeout refunds), no stable release
  supports `soroban-sdk` 27, so no crate is adopted — the audited
  checks-effects-interactions ordering is applied directly instead
  (`settle()` writes status before transferring; rollback test added).
  Dependency pinning/update policy + measured wasm/CPU comparison in the
  ADR (wasm 24,516 → 29,338 bytes; settlement paths +1.3–1.6%).
  **#119:** ADR 0007 adds an optional in-contract M-of-N releaser set:
  `create_escrow_with_releasers`, `release_with_approvals`,
  `refund_with_approvals`; one-call approvals (no stored state, nothing to
  replay), duplicates rejected, `MAX_RELEASERS = 10`, errors 13–17;
  `EscrowData` now carries `releasers` + `threshold` (single-releaser
  escrows store 1-of-1 and keep using `release`/`refund`). 19 new tests;
  57 contract tests green. SDK 0.4.0 → **0.5.0** (breaking read shape), with
  `createQuorumEscrow`/`releaseWithApprovals`/`refundWithApprovals`,
  offline validation tests, and regenerated bindings. **Not yet on testnet.**
  **#120:** committed `test_snapshots/` for every test (57 files) and a CI
  drift check; documented how to update them intentionally and the
  last-invocation-only event-capture caveat.
  **#121:** pinned the Stellar CLI (`scripts/stellar-cli-version`, 28.1.0 +
  tarball checksum), added `scripts/check-generated-bindings.sh` and the
  `sdk-bindings` CI job; regenerating against the current WASM revealed the
  committed bindings were stale (missing `top_up`, `create_*` docs and
  errors 6–8) — now fixed. CI's offline SDK step also runs the new quorum
  validation tests (`npm run test:offline`). Note on numbering: Phase E6
  above references `docs/adr/0005` (npm publishing), but that file is not in
  this tree — 0006 and 0007 are used by this batch to avoid overwriting it if
  it lands later.
- 2026-10-17 — Phase E5 started: bounded `condition_ref` to 64 bytes at
  creation (new error `ConditionRefTooLong = 7`), added contract test,
  added SDK client-side validation (`MAX_CONDITION_REF_LENGTH`), updated
  T10, README and ARCHITECTURE_ESSENTIALS.md. Not yet redeployed to
  testnet. Closes issue #57.
- 2026-10-18 — Fixed PR #183's contract CI after merging newer `main`:
  restored the `IntoVal` import, assigned `CallbackFailed` error code 8
  after `DisallowedToken` code 7, supplied the callback opt-in and
   allowlist constructor arguments in affected tests, and regenerated the
   SDK binding from the merged contract spec. `cargo test` and the WASM
   release build pass locally.
- 2026-10-16 — Implemented the immutable deploy-time token allowlist for
  issue #36. Contract tests/docs updated; awaiting a new testnet deployment
  before claiming the protection is live.
- 2026-10-17 — Issue #63 (Phase E6): added SDK `getEvents` pagination and
  typed lifecycle-event decoding, preserving unknown topic variants for
  forward compatibility. Added cursor-resumable serial polling with
  handler back-pressure and typed RPC-retention errors. Committed Soroban
  XDR event fixtures cover decoding, filters, unknown topics, cursor
  resume, retention errors, and stopping. Bumped the additive SDK surface
  from 0.3.0 to 0.4.0. SDK typecheck/build and contract tests/build pass;
  lifecycle events remain unavailable until issue #9 changes the contract.
- 2026-10-18 — Phase E7 (issue #64): added a pure-Rust reference
  model of the escrow state machine (`contracts/escrow/tests/model.rs`)
  and proptest state-machine tests comparing contract results and stored
  state against the model after every generated operation, including
  auth outcomes. CI runs a bounded case count; a nightly workflow runs
  a larger one.
- 2026-09-09 — Repo created as part of the DocForum 3-repo org split.
- 2026-10-09 — Phase E6 started: added `.github/workflows/release-sdk.yml`
  (tag-triggered `sdk-v*` build/test/`npm publish --provenance` + GitHub
  Release tarball, OIDC trusted publishing, tag/version guard), adopted
  changesets, wrote `docs/adr/0005` superseding ADR 0003, and documented
  the one-time npm org/trusted-publishing human steps in `CONTRIBUTING.md`.
  npm publish itself still pending those human steps. Closes issue #16.
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
- 2026-09-15 — Redeployed to testnet with the Phase E2 signature
  (`CAXESEEAJILFFCN3PH2HHNMWAAHLEB64UTJHZ6IP7C5BBICT3S3VODSM`, supersedes
  the Phase E1-only deployment) and verified `release`/`refund` live:
  real fund transfers on both paths, plus a real unauthorized-caller
  rejection (`Error(Contract, #3)`) confirmed via the contract's own
  diagnostic events, not just a local assertion. Closes the "not yet
  done" gap from the previous entry. Full record:
  `docs/testnet-deployments.md`.
- 2026-09-15 — Built the TypeScript SDK (`@docforum/escrow-sdk`),
  closing issue #4: `sdk/src/generated/contract-client.ts`
  (machine-generated from the local wasm build via `stellar contract
  bindings typescript`) plus a hand-written `EscrowClient` in
  `sdk/src/index.ts` wrapping all four contract functions — expanded
  from #4's original create_escrow/get_status-only scope since Phase E2
  landed in the same session, so there was no reason to ship an
  immediately-stale SDK. Accepts a `Keypair` directly as a signer (no
  manual XDR signing exposed). 3 real tests in
  `sdk/tests/testnet-integration.test.ts`, all passing against the live
  Phase E2 deployment — full release lifecycle, full refund lifecycle,
  unauthorized-caller rejection — satisfying Phase E3's "integration
  test against testnet from the SDK itself" item. Deliberately kept out
  of `npm test`/CI (`npm run test:integration` only, CI runs
  `typecheck`+`build`) given its dependency on live testnet + Friendbot
  funding, a different reliability profile than this org's other
  self-contained integration tests. `ARCHITECTURE_ESSENTIALS.md` updated
  with the SDK's actual public surface.
- 2026-09-15 — Closed issue #5: decided **not** GitHub Packages (its npm
  registry requires auth even for public packages — would break `npm
  ci` for any external contributor's fork, exactly what the issue
  warned against). First tried an npm git-subdirectory dependency
  (`github:DocForum/docforum-escrow#path:sdk`) as a zero-infrastructure
  option — tested it against `docforum-core` and it failed (npm 10.8.2
  doesn't support the subdirectory selector the way assumed). Replaced
  with a tarball attached to a real tagged GitHub Release (`sdk-v0.1.0`,
  via `npm pack` + `gh release create`) — verified working end-to-end:
  installed and imported successfully from `docforum-core/backend` with
  zero auth. Added a `prepare: npm run build` script to
  `sdk/package.json` (unused by this specific approach, but harmless to
  keep for a future git- or workspace-based route). Real npm
  registry publish remains the long-term goal, blocked on publishing
  credentials this environment doesn't have. See `docs/adr/0003`.
- 2026-09-15 — SDK v0.2.0 (breaking, per hard rule 3): `createEscrow`,
  `release`, and `refund` now also return the transaction's hash
  (`{ escrowId, txHash }` / `{ txHash }`) instead of discarding it —
  needed by `docforum-core`'s payments module to persist
  `stellarTxHash`. All 3 live-testnet tests updated and still passing.
  Republished as GitHub Release `sdk-v0.2.0` (see ADR 0003's release
  process); `docforum-core` updated to depend on the new tarball URL.
- 2026-09-15 — Fixed two real bugs in `docs/adr/0003` that broke
  `docforum-core`'s VitePress docs-site build entirely ("Element is
  missing end tag" — VitePress parses markdown through a Vue template
  compiler, which can misread certain angle-bracket placeholder text as
  an unclosed HTML tag): a placeholder phrase with a space inside
  angle brackets, and — found only after the first fix still didn't
  build — two separate bracketed placeholders inside one inline code
  span. Both rephrased to avoid angle-bracket placeholder syntax
  entirely rather than guessing at a safe form. Caught, and actually
  fixed for real (not just believed fixed), while checking the live
  docs site reflects this session's changes rather than assuming it
  did — verified by building `docforum-core`'s docs site locally against
  this exact file, twice, before trusting it.
- 2026-09-26 — Updated the stale top status line (still said issue #5
  was open; it closed 2026-09-15).
- 2026-10-01 — Drafted `docs/threat-model.md` for Phase E4 (issue #6):
  invariants, actors, ten threats with severity, SDK and consumer
  integration notes, and a proposed pre-mainnet checklist. No contract
  changes. Self-written, so E4 stays open pending independent review.
- 2026-10-08 — Closed issue #11 (Phase E4: timeout refund path when the
  releaser key is lost). **ADR first:** `docs/adr/0004` picks the threat
  model's candidate — an optional `refund_after` unix timestamp set at
  `create_escrow`, after which anyone may `refund`, always only back to
  `payer` — and compares it against a privileged unlock role, releaser
  rotation, and doing nothing; it also spells out what the deadline means
  for payees (T8): the commitment expires, `get_escrow` lets them read
  it, and the new risk is bounded to "delayed then reversed", never
  redirected. **Implementation:** `refund_after: Option<u64>` added to
  `create_escrow` (rejects a deadline not strictly in the future — new
  `Error::InvalidRefundAfter = 5`), `refund` accepts any caller once the
  deadline has passed (state rules unchanged: still `Funded` only),
  `release` deliberately *not* gated by the deadline (the releaser keeps
  its right; whoever lands first wins, the loser gets `NotFunded`), plus
  a read-only `get_escrow` so the deadline is inspectable on-chain. With
  no `refund_after`, behaviour is exactly what it was before. **Tests:**
  17 new in `tests/timeout_refund.rs` covering every edge case issue #11
  lists (release in the same ledger the timeout passes — both orders;
  deadline already past at creation; already released/refunded before the
  timeout; no deadline at all) — 28/28 passing repo-wide, wasm release
  build verified. **Breaking change:** `create_escrow`'s signature and
  `EscrowData`'s layout both changed, so the contract was redeployed to
  testnet (`CAHQ4J3T23WSIBBG6SI6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEV5`,
  supersedes the Phase E2 deployment, kept as history) and verified live
  with a real non-releaser timeout refund after the deadline, a real
  release after the deadline, and real rejections for a pre-deadline
  stranger refund (`#3`), a past deadline at creation (`#5`) and a second
  refund (`#4`) — full record with tx links in
  `docs/testnet-deployments.md`. **SDK:** bindings regenerated from the
  new wasm (never hand-edited), `@docforum/escrow-sdk` **0.2.0 → 0.3.0**
  (breaking, per hard rule 3; same 0.x-minor-for-breaking convention as
  0.1.0 → 0.2.0), adding optional `refundAfter` on `createEscrow` and a
  `getEscrow()` accessor; migration steps for `docforum-core` are in ADR
  0004. All 5 SDK integration tests pass against the new deployment
  (`npm run test:integration`, still kept out of CI).
  `ARCHITECTURE_ESSENTIALS.md`, `README.md` and `docs/threat-model.md`
  (§1 invariants, T2, T8, §6) updated. **Not done:** publishing the
  `sdk-v0.3.0` release tarball per ADR 0003 — that's the follow-up step
  before `docforum-core` can consume it.
- 2026-10-08 — Fixed `main` failing to compile after #17 and #18 merged
  minutes apart: both added an error variant numbered 5, and the merge
  kept #18's `InvalidRefundAfter = 5` and dropped #17's
  `BalanceMismatch`. Restored it as `BalanceMismatch = 6` (5 is already
  live on testnet as `InvalidRefundAfter`), and added `refund_after:
  None` to #17's mock-token tests, written before #18 changed
  `create_escrow`'s signature. 31/31 contract tests pass, wasm build
  succeeds. **Not yet done:** the current testnet deployment (source
  `7a595d8`) predates #17, so it doesn't include the balance-delta check
  — needs a redeploy.
- 2026-10-08 — Restored two sets of ROADMAP entries lost in merge
  conflict resolution: #17's (issue #12, balance-delta check — Phase E4
  item and its 2026-10-07 changelog entry, summarised here: contract
  rejects escrows whose token balance doesn't rise by exactly `amount`,
  three malicious mock-token tests, re-entry confirmed fail-closed), and
  #16's (links to the threat-model issues #8–#10 and #13–#15; #11 and
  #12 were opened and closed in between). #16 merged with an empty diff
  because its branch's merge from `main` kept `main`'s ROADMAP.md
  wholesale.
- 2026-10-20 — Added the PR conflict notifier workflow (see the CI item above): maintainers no longer need to manually ask authors to rebase after each merge.
- 2026-10-20 — Hardened the PR automation against transient GitHub API errors. Today a single 500/503 response aborted a whole conflict-notifier run, so no PR after it got labelled. Both `pr-conflict-notifier.yml` and `pr-malware-scan.yml` now set `retries: 3` on `actions/github-script`, so 5xx responses are retried. The notifier also isolates each PR: a PR whose API calls still fail is skipped with a warning, listed as "API error, retried next run" in the run summary, and the remaining PRs are processed normally.
- 2026-10-16 — Phase E5, issue #28: sponsored funding. ADR 0009 first
  (separate refund destination is compatible with I1; the funder
  authorises it in the creation signature). Then optional `refund_to` on
  `create_escrow` (default `payer`), used by every refund path, with
  `Error::InvalidRefundTo = 21` for the contract's own address. 16 new
  tests in `tests/sponsored_refund.rs`; 47/47 contract tests pass
  repo-wide, wasm release build succeeds. SDK bindings regenerated;
  `@docforum/escrow-sdk` 0.5.0 → 0.6.0 (breaking). I1 wording, actors, T1,
  T2, T8, new T11 (now T21) and §6 in the threat model, `README.md` and
  `ARCHITECTURE_ESSENTIALS.md` updated. **Not done:** testnet redeploy and
  the `sdk-v0.6.0` release tarball.
- 2026-10-20 — Issue #109: deployed current upstream main to Stellar testnet and verified
  create, release, refund, timeout refund, and a real `BalanceMismatch`
  rejection using the fee-on-transfer test token. Updated the SDK testnet
  contract ID and deployment documentation; previous deployment records remain
  as history. The SDK 0.6.0 release tarball and notification to
  `docforum-core` issue #32 still require authenticated release access.
- 2026-10-20 — Contributing: changelog entries now go in `changelog.d/` (one new file per
  PR) instead of being appended to this section, which used to put most open
  PRs into merge conflict on every merge. Maintainers fold them in with
  `node scripts/fold-changelog.mjs`. The contract surface now lives only in
  `ARCHITECTURE_ESSENTIALS.md` (the `README.md` section is a summary that
  links there), with the few README-only details moved across, and its
  `refund_to` ADR reference and timeout-refund destination corrected. Also
  dropped the hard-coded test count from the README, and documented the
  "edit only your own lines" and "regenerate, don't hand-merge,
  `contract-client.ts`" rules in `AGENTS.md` and `CONTRIBUTING.md`. The
  conflict notifier now points authors at `changelog.d/`.
- 2026-10-21 — Phase E6 integrator tooling (issues #126, #127, #128, #129).
  #127: `EscrowClient` now accepts a SEP-43 `Signer` anywhere it accepted a `Keypair`; added `WalletsKitSigner` on the `@docforum/escrow-sdk/signers/wallets-kit` subpath with an injected, optional Wallets Kit peer and no runtime import of it. Wrong-network signing throws `WalletNetworkMismatchError`; user rejection is a normal SEP-43 `-4` outcome.
  #129: optional `instrumentation`/`onEvent` with `simulate`/`sign`/`submit`/`confirm` spans and retry counts; addresses opt-in only; the disabled path does no timing work. SDK `0.5.0 → 0.6.0` (additive).
  #126: new `@docforum/escrow-react` package with `useEscrow`, `useEscrowActions`, `useEscrowTimeline`, React Query caching and polling that stops at terminal statuses; 14 RTL tests and a CI job.
  #128: new `sdk-go/` client with typed contract errors, `big.Int` i128 amounts, offline tests and an opt-in quickstart integration workflow.
  Added `examples/web-demo/`, docs and roadmap entries. Closes #126, #127, #128, #129.
  Go SDK: `GetEscrow` now decodes `refund_to` as the contract's `Address`
  (`ScvAddress`) instead of a string, and the create helpers encode `RefundTo`
  as an address-backed option. Fixes the quickstart integration job's
  `expected string ScVal, got ScValTypeScvAddress` failure.
- 2026-10-21 — Issue #27 (Phase E5): payer `cancel` before the payee accepts, ADR 0010.
  `cancel(escrow_id, payer)` works only while `Funded`, on an escrow created with
  the acceptance gate, and before `accept`; funds go to the stored `refund_to`.
  New terminal `EscrowStatus::Cancelled`, no new error codes. SDK
  `client.cancel()`, bindings regenerated, `@docforum/escrow-sdk` 0.6.0 → 0.7.0.
  Not yet on testnet.
- 2026-10-21 — Issue #91 (Phase E7): pinned Rust and Stellar CLI versions; added remapped WASM builds and a two-checkout-path CI check in a pinned Rust container; added `contract-v*` WASM and SHA-256 release assets, a testnet-only deployment verifier, and third-party verification instructions. Contract tests/build and two-path comparison pass locally; live testnet fetch returns the recorded older hash as expected.
- 2026-10-21 — Malware scan: `.vue`, `.svelte`, `.astro`, `.less`, `.sass`, `.go`,
  `go.mod` and `go.sum` files are now scanned as code. Before this, a Vue
  single-file component was flagged HIGH as "disguised code" (JavaScript
  inside a file with a non-code extension), which wrongly blocked
  docforum-core #207. The same line rules still apply to these files.
- 2026-10-21 — Malware scan: closed three gaps found in the malicious docforum-web #137,
  which only had three of its nine problems flagged. Code pushed off-screen by
  leading whitespace is now flagged (`api.js` hid its payload behind 315 tabs).
  A `package.json` script such as `dev` or `build` that now also runs
  `node <file>` (or bun, deno, sh, bash, python) alongside its original command
  is flagged as `script-hijack`. The `global['!'] = …` marker of the loader used
  in escrow #163 and web #137 is flagged as `known-payload`. The whole-line
  heuristics no longer stop the per-line rules from running on the same file.
- 2026-10-21 — Malware scan: TLA+ specifications (`.tla`) are now scanned as text, like
  other source files. Before this, a TLA+ spec was flagged HIGH as "disguised
  code", which wrongly blocked docforum-escrow #225. Every line rule still
  applies to `.tla` files.
- 2026-10-22 — ### Added
  - `sdk/src/factory.ts`: `predictInstanceAddress(factoryId, salt, networkPassphrase?)`
    derives the contract address a factory's `deploy_instance` will create,
    offline, using the CAP-0046 preimage (deployer address + salt + network id).
  - `FactoryClient` (`deployInstance`, `getInstance`, `forIntegrator`) for a
    factory that exposes `deploy_instance(integrator, salt)` and
    `get_instance(integrator)`, plus `randomSalt()`.
  - `EscrowClient.forIntegrator(factoryClient, integrator)` builds a client bound
    to an integrator's instance.
  - `sdk/tests/factory.test.ts` pins a golden derivation vector, and the live
    factory suites only run when `TESTNET_FACTORY_ID` points at a deployed
    factory (none ships in this repo yet).
  Closes #205.
- 2026-10-22 — Issue #224: fixed the nightly testnet soak failures in the TypeScript SDK.
  `authorizeRelease`, `authorizeRefund` and `submitRelayed` were documented in
  the README but never implemented; they now simulate the settlement, collect
  only the releaser's short-lived auth entry, and let a separate relayer sign the
  envelope and submit it. `getEscrow` now falls back to decoding `get_escrow` by
  field name when the generated positional decoder meets a testnet deployment
  that predates a newer `EscrowData` field such as `release_not_before`. Added
  offline coverage in `sdk/tests/relayed.test.ts` and
  `sdk/tests/escrow-data.test.ts`, and wired both into `npm run test:offline`.
  No contract change; the generated bindings are unchanged.
- 2026-10-22 — Issue #71 (Phase E6): added a milestone (tranche) surface to the SDK —
  `createMilestoneEscrow`, `releaseMilestone`, `refundMilestone`,
  `getMilestones`, plus `validateMilestoneSchedule` / `MilestoneScheduleError`
  and `MilestoneEscrowPartialError`.
  The deployed contract is single-tranche and the native multi-tranche entry
  point is still the Phase E5 contract work (issue #21), so a schedule is
  modelled client-side as one ordinary escrow per tranche, tagged
  `<conditionRef>#m<i+1>/<n>`. No contract change and no hand-edit of
  `sdk/src/generated/contract-client.ts` — the generated bindings are
  byte-identical to a fresh generation from the current WASM, which is what the
  `SDK bindings match contract WASM` CI check verifies. `sdk/package.json`
  gains `test:milestones`, run by CI; the schedule arithmetic, the ref tagging,
  the per-tranche settlement calls and the partial-failure state are all
  covered by offline tests.
- 2026-10-22 — Issue #74 (Phase E5): added batched escrow creation and settlement. The
  contract gains `create_escrows(payer, items)` (atomic, `items.len()` <=
  `MAX_BATCH_SIZE` = 50) and `settle_many(caller, escrow_ids)` (per-op
  `Result` in input order), and the `BatchTooLarge` error is appended at
  discriminant 25 so every existing `Error` value keeps its on-chain number.
  The SDK gains `createEscrows(items)` / `settleMany(ops)`: they chunk to
  `MAX_BATCH_SIZE`, map results back to the caller's input order, throw a
  `BatchPartialFailureError` carrying every per-item result when anything
  fails, and accept `{ resumeFrom }` so a retry only sends what failed. The
  batching is implemented in the wrapper by looping over the existing
  singular `create_escrow` / `release` / `refund` calls, so no per-batch auth
  or state semantics are introduced on the client. `sdk/src/generated/`
  was regenerated with the pinned Stellar CLI 28.1.0.
- 2026-10-22 — Added a contract test for `release_not_before` equal to the creation time (valid, and releasable straight away). The first nightly mutation-testing run found that replacing `<` with `<=` in that creation check (`src/lib.rs:594`) changed no test result. The new test fails on that mutant.
- 2026-10-23 — Issue #113 (Phase E5): pooled escrows funded by multiple payers with
  pull-based pro-rata refunds, decided in `docs/adr/0011` (open
  contributions until an explicit funding target vs a fixed contributor
  list — open contributions chosen). New contract entry points
  `create_pooled_escrow`, `contribute`, `claim_refund`, `get_pooled`,
  `get_contribution`; append-only errors 26–34; `EscrowData` and every
  existing entry point unchanged, so single-payer behavior is untouched
  and all pre-existing test snapshots are byte-identical. `release` now
  requires `funded == target` on pooled escrows; push refund/cancel/top_up
  are rejected for them (`NotSupportedForPooled`); a missed funding
  deadline opens per-contributor `claim_refund` (exact recorded amounts,
  once each, no contributor iteration — no cap by design). Threat model
  I1–I4 generalized plus new T16–T19. SDK: additive wrappers
  (`createPooledEscrow`/`contribute`/`claimRefund`/`getPooled`/
  `getContribution`) and regenerated bindings, `0.7.0 → 0.8.0` (minor).
  Not yet deployed to testnet — the live deployment predates it.
- 2026-10-24 — Issue #101 (Phase E4): added the formal-verification spike for invariants
  I1–I3 and the timeout rule. `certora/escrow.spec` states each property against
  the current settlement entry points and `Error` discriminants, and
  `docs/formal-verification.md` records the scope, assumptions, out-of-scope
  areas and current status (specified, not yet machine-checked — Certora Sunbeam
  needs a licensed toolchain, so there is no CI job). The threat model links
  I1–I3 to their properties. No contract behaviour or SDK surface changed.
- 2026-10-24 — Issue #110 (Phase E7): added the `Futurenet compatibility checks` workflow
  (`.github/workflows/futurenet-compatibility.yml`) — manual `workflow_dispatch`
  plus a weekly schedule, never on `pull_request`, so PRs are never blocked on
  futurenet. It builds the current WASM, installs the Stellar CLI pinned in
  `scripts/stellar-cli-version` (release tarball, sha256 verified), deploys to
  futurenet with a generated identity, and runs the futurenet SDK integration
  suite (`npm run test:futurenet`, scoped by `sdk/vitest.futurenet.config.ts`).
  Futurenet resets are handled gracefully, and per-protocol reports live under
  `docs/futurenet-compatibility-reports/`. No contract or SDK surface change.
- 2026-10-24 — Issue #111 (Phase E4): added the audit-readiness material for external
  reviewers. `SECURITY.md` documents private reporting, triage and disclosure;
  `docs/audit/` records the reviewed commit, the in- and out-of-scope files, and
  reproducible test/build results; `CONTRIBUTING.md` explains how contributors
  report privately and respect the reviewed scope; the threat model gains a
  clearly-labelled planned-features section (T12, now T23) and states that milestones,
  disputes, splits and attestations are not implemented yet. No contract, SDK or
  CI change.
- 2026-10-24 — Issue #50 (Phase E5): documented the optional M-of-N custom releaser account in `ARCHITECTURE_ESSENTIALS.md`, `docs/threat-model.md` (T1) and `ROADMAP.md`. The account contract already on `main` (`contracts/releaser-account/`, ADR 0005) is unchanged; this PR resolves the duplicate add/add conflicts by keeping `main`'s newer implementation. No escrow contract change, so generated bindings are unaffected. Not deployed to testnet.
- 2026-10-24 — Issue #84 (Phase E6): SDK `topUp`, `accept` and `createEscrow({ requiresAcceptance })`;
  `cancel` now takes any `EscrowSigner`. All three check preconditions client-side
  first and throw `EscrowPreconditionError` (`InvalidAmount`, `NotFunded`,
  `Unauthorized`, `AcceptanceNotConfigured`, `AlreadyAccepted`); pass
  `checkPreconditions: false` to skip the read. New `prepareLifecycleCall` /
  `signLifecycleCall` / `submitLifecycleCall` pass a call between signers as JSON.
  `getEscrow` now returns `requiresAcceptance` and `acceptedAt`. No contract
  change, bindings unchanged. `@docforum/escrow-sdk` 0.7.0 → 0.8.0.
  `extendRefundAfter` and `refundByPayee` follow once #41 and #40 land.
- 2026-10-24 — Issue #89 (Phase E7): added `scripts/deploy`, one command for deploy → verify
  → record. It builds or takes the WASM, checks its SHA-256, uploads and deploys
  it with the constructor allowlist, confirms the on-chain WASM matches, runs a
  scripted live verification (create, release, refund; stranger release, double
  release and zero-amount rejections), and records the result in
  `deployments.json`, `docs/testnet-deployments.md` and
  `sdk/src/deployments.generated.ts`. It refuses a dirty git tree and any network
  except testnet; `--dry-run` runs against a local quickstart without touching
  tracked files. The SDK adds `knownContractId`, `knownNetworkConfig`,
  `latestDeployment` and `parseDeployments` with no filesystem access, so it
  still runs in browsers, Deno and Bun. No contract change.
- 2026-10-24 — Issue #98 (Phase E7): added a Soroban resource profile for the 13 functions
  in the resource baseline. A dedicated status record reduces `get_status`
  CPU instructions by 41% and memory by 52% in the measured native test
  environment, while increasing create and settlement costs due to the extra
  persistent write. Moving `NextId` to persistent storage was rejected because
  it raised create costs further. The status key changes storage layout and
  requires redeployment under a new testnet contract ID per ADR 0005.
- 2026-10-24 — Refreshed the TypeScript SDK's lockfile to clear high-severity advisories in its dependency tree: `@stellar/stellar-sdk` 16.3.0 → 16.4.1 (which pins axios 1.18.0 → 1.20.0, fixing the prototype-pollution, header-injection, ReDoS and SSRF advisories), `follow-redirects` 1.16.0 → 1.16.1 and `smol-toml` 1.8.0 → 1.9.1. Lockfile-only and within the existing ranges, so consumers of the published package already resolve these versions.
- 2026-10-26 — Issue #81 (Phase E6): added token-aware amount helpers to the SDK
  (`sdk/src/amounts.ts`). `getTokenInfo(token)` reads `decimals`, `symbol` and
  `name` from the SEP-41 token contract and caches them per address;
  `parseAmount('12.5', decimals)` and `formatAmount(bigint, decimals)` convert
  with strict validation — floats/exponents (`1e3`), excess fractional
  precision (`0.00000001` at 7 decimals), thousands separators and negatives
  (including `-0`) are rejected rather than rounded. Property tests cover
  `format(parse(x)) == normalise(x)` and run in CI via `npm run test:unit`.
  Additive SDK surface, no contract change, so the generated bindings are
  unchanged. The web demo now shows amounts via `formatAmount`.
- 2026-10-26 — Issue #99 (Phase E7): added a cargo-fuzz lifecycle target for randomized
  create, release, refund and ledger-time sequences, including malicious token
  mocks, with invariant checks after each operation. CI runs short pull-request
  fuzzing and a longer nightly pass, and uploads crash artifacts. No contract
  or SDK behavior changed.
- 2026-10-27 — The contract now exposes its semantic version and embeds the source revision and locked Soroban SDK version in WASM metadata. Reproducible builds use an explicit CI SHA and mark local builds unknown.
- 2026-10-27 — Issue #67 (Phase E6): added SDK network presets (`networks.testnet`,
  `networks.futurenet`, `networks.local`) carrying an RPC URL, network
  passphrase and known contract ids, plus an explicit mainnet opt-in guard:
  constructing an `EscrowClient` with the mainnet passphrase throws
  `MainnetNotAllowedError` unless `allowMainnet: true`. When a preset is
  selected (or `verifyNetwork: true` is passed) the client verifies the RPC's
  `getNetwork` passphrase lazily, once, before its first network call, and
  throws `NetworkMismatchError` on a mismatch; it never runs in the
  constructor, the result is cached per client and a failed check is not
  cached. With a preset only, an RPC without `getNetwork` (an offline test
  double) is skipped; an explicit request makes that an error, and
  `verifyNetwork: false` turns the check off. Clients without a preset make no
  extra requests. Custom networks still work, and plain-HTTP RPC (local
  quickstart) needs `allowHttp`, which `networks.local` sets. No contract
  change, so the generated bindings are unchanged.
- 2026-10-27 — Issue #94 (Phase E4): added `docs/runbooks/releaser-compromise.md`
  (detection signals, decision tree, roles, race-to-settle steps), linked from
  threat model T1, and `scripts/settle-outcomes.py`. The script validates the
  integrator's outcome file, never chooses an outcome, runs the operator's own
  submit command per escrow, and records each successful transaction hash in a
  JSON-lines state file (`<outcomes>.state.jsonl`, rewritten atomically) so a
  re-run after a crash, rate limit or fee spike skips settled escrows and
  retries the rest. Stdlib only, Python 3.9+, with offline tests in
  `scripts/test_settle_outcomes.py` run by a new CI job. The 50+ escrow testnet
  drill is still to be run and recorded in the runbook. No contract or SDK
  change.
- 2026-10-27 — Issue #29 (Phase E5): batch release and refund. `settle_many` now takes
  `ops: Vec<(escrow_id, SettleAction)>` (`Release` | `Refund`) instead of
  release-only `escrow_ids`, and `caller` authorizes the batch once (the
  old version called `release` per id, so any batch of two or more failed
  `Error(Auth, ExistingValue)`). Each op runs exactly the checks of
  `release`/`refund` against that escrow's own releaser set, shared through
  `release_checks`/`refund_checks` so the paths can't diverge. Best-effort,
  decided in `docs/adr/0012`: one result per op in input order, `Err` means
  untouched, the same escrow twice gives `NotFunded` on the second op, and
  a failure after an op's transfer (a failing payee callback) reverts the
  whole batch. Bound `MAX_SETTLE_OPS` = 20, measured: 656 bytes of events
  per release against the 16,384-byte events budget (13,120 at 20).
  Existing error codes unchanged (`BatchTooLarge` = 25 reused). T1
  response guidance in `docs/threat-model.md`. 13 tests in
  `tests/settle_many.rs`. Bindings regenerated (SDK patch). Not yet
  deployed to testnet.
- 2026-10-27 — Issue #30 (Phase E5): optional protocol fee taken at release. `create_escrow`
  (and `create_escrow_release_time`) accept an optional `fee_recipient`/`fee_bps`
  pair, fixed at creation, capped at 10 % and floor-rounded; `release` pays that
  share to `fee_recipient` and the exact remainder to the payee, while refunds
  still return the full amount. `get_escrow` exposes the pair, the `ESCROW`
  event snapshot appends it as one nested pair, and `top_up` re-checks the fee
  math as the amount grows. Decided in `docs/adr/0010`; new invariant I7 in the
  threat model; new append-only error `InvalidFee = 35`. The SDK gains
  `feeRecipient`/`feeBps` on `createEscrow` (minor changeset) and regenerated
  bindings. Not yet redeployed to testnet.
- 2026-10-27 — Issue #39 (Phase E5): per-token liability accounting and an on-chain
  solvency view. New read-only `solvency(token) -> (balance, liabilities)`;
  `liabilities` is the sum of `amount` over every `Funded` escrow in that
  token, kept in a new persistent `DataKey::Liability(token)` entry
  (appended last, so existing storage encodings are unchanged) whose TTL is
  re-extended on every write. The counter is increased in
  `transfer_in_exact` (the single inbound path for every creation entry
  point, `top_up` and `contribute`) and decreased in `settle()` and
  `claim_refund`, always in the same invocation as the state change.
  `tests/liabilities.rs`: 14 tests, including a proptest that runs random
  sequences over every state-changing entry point and checks, after each
  step, that liabilities equal the per-token sum of `Funded` amounts and the
  contract balance. Monitoring guidance in `docs/threat-model.md`. Existing
  test snapshots change only by the new `Liability` storage entry. SDK:
  `client.getSolvency(token)` and regenerated bindings (minor). Not yet
  deployed to testnet.
- 2026-10-27 — The SDK now publishes ESM and CommonJS builds with matching declarations and a browser-compatible ESM entry. CI smoke checks exercise Node imports and a browser bundle.
- 2026-10-27 — Phase E6 (issue #247): added multisig releaser setup helpers to the SDK.
  `buildMultisigSetup` returns one atomic `setOptions` transaction (thresholds,
  one operation per signer, master key weight zeroed last) and refuses any
  configuration that would lock the account out; `dryRunMultisigSetup` and
  `verifyMultisig` cover review and on-chain verification. Client-side only — no
  contract change, so the generated bindings are unchanged.
- 2026-10-28 — Issue #55 (Phase E5): `release` now uses `try_transfer` for the payout. If the
  token rejects the transfer (for example a SAC payee whose trustline was
  deauthorised, or a contract payee that rejects the funds), the call returns the
  new append-only `Error::Undeliverable = 35` and the escrow stays `Funded` with
  its balance intact, so the releaser can retry once the payee is reachable or
  use the refund path. Refund transfers are unchanged. Tests in
  `contracts/escrow/tests/undeliverable.rs`; generated SDK bindings regenerated
  for the new error code.
- 2026-10-28 — Contract changes now use fragments in `contract-changes.d/` instead of each
  PR bumping `CONTRACT_VERSION`, which put every open contract PR into conflict
  on each contract merge. New `Error` variants use provisional codes
  (issue number × 100 + n) until the maintainer fold
  (`scripts/fold-contract-changes.mjs`) bumps the version once per batch and
  assigns final codes. CI's "Contract changes use a fragment, not a version
  bump" step (`scripts/check-contract-change.mjs`) replaces the old
  "Require a contract version bump" step. The version test now compares with
  `CONTRACT_VERSION` instead of a literal.
- 2026-10-28 — Issue #40 (Phase E5): the stored payee can now voluntarily refund a funded escrow with `refund(escrow_id, payee)`. The payout still goes only to the stored `refund_to` (ADR 0009), and the call emits a distinct `payee_refunded` event (ADR 0010). Pooled escrows reject it through `reject_pooled`. Bindings regenerated, and the TLA+ model gained a `PayeeRefund` action.
- 2026-10-28 — Issue #45 (Phase E5): added `transfer_payee(escrow_id, current_payee, new_payee)` — restricted to the current payee (require_auth), only while Funded; `new_payee` may not be the contract address or the payer. Rotation tool, not key-loss recovery. 12 tests in `contracts/escrow/tests/transfer_payee.rs`. New error `Error::InvalidNewPayee` (code 37). Contract surface updated in `ARCHITECTURE_ESSENTIALS.md`; threat model I1 updated and T11 added (now T22). `CONTRACT_VERSION` is left for the maintainer fold, per `contract-changes.d/README.md`.
- 2026-10-28 — Issue #9 (Phase E4, T7): cover the contract's full-state lifecycle events on create, release, refund, and cancel, keyed by escrow_id. Error paths emit nothing. Added contract tests in `contracts/escrow/tests/events.rs`, documented the indexer-compatible payload in `ARCHITECTURE_ESSENTIALS.md § Events`, and marked T7 mitigated in `docs/threat-model.md`.
- 2026-10-30 — Contract 2.4.0 (was 2.3.0), folded from 2 change(s):
  - Issue #40: allow the stored payee to authorize a voluntary full refund of a funded single-payee escrow to its stored payer destination, and emit a distinct `payee_refunded` event.
  - Issue #45 (Phase E5): new `transfer_payee(escrow_id, current_payee, new_payee)` entry point — only the current payee may authorize it, only while the escrow is `Funded`, and `new_payee` may be neither the contract address nor the payer. Emits a `pay_xfer` event and adds `Error::InvalidNewPayee` (code 37). Rotation tool, not key-loss recovery; covered by `contracts/escrow/tests/transfer_payee.rs`.
  Final error codes: Error::InvalidNewPayee 4500 -> 37.
- 2026-10-31 — Issue #35 (Phase E5): deposit-only emergency pause. The contract's
  `__constructor` now also takes a `pause_admin` address; only that custodian
  can call `pause`/`unpause`, and while paused every deposit path fails with
  `Paused` before any funds move — including pooled `create_pooled_escrow`
  and `contribute` (`Paused`, plus `AlreadyPaused`/`NotPaused` for the
  transition guards — codes 38–40). `release`, `refund`, the timeout refund and pooled
  `claim_refund` never read the flag, so a
  pause can stop new exposure but never lock escrowed funds (invariant I8,
  threat model T12, `docs/adr/0011`). The SDK gains `pause`/`unpause`/
  `isPaused`/`getPauseAdmin` (minor changeset) and regenerated bindings. This
  is a deployment change: the live testnet contract predates the constructor
  and cannot pause until it is redeployed.
- 2026-10-31 — Contract 2.5.0 (was 2.4.0), folded from 1 change(s):
  - Issue #35 (Phase E5): deposit-only emergency pause (ADR 0011). The constructor gains a second argument (`pause_admin`) and the contract gains `pause`/`unpause`/`is_paused`/`get_pause_admin` entry points plus the `Paused`/`Unpaused` events and the `Paused`, `AlreadyPaused`, `NotPaused` errors (codes 38–40). Every deposit path is gated — `create_escrow` and its variants, `top_up`, and pooled `create_pooled_escrow`/`contribute` — while `release`, `refund`, the timeout refund, pooled `claim_refund` and both `settle_many` ops never read the flag, so a pause can never lock funds already escrowed.
  Final error codes: Error::Paused 3500 -> 38, Error::AlreadyPaused 3501 -> 39, Error::NotPaused 3502 -> 40.
- 2026-11-01 — Contract 2.5.1 (was 2.5.0), folded from 1 change(s):
  - `create_escrows` now works for more than one item: `payer` authorizes once for the whole batch instead of once per item, which aborted with `Error(Auth, ExistingValue)`. `MAX_BATCH_SIZE` drops from 50 to 16, because 24 items already exceed Mainnet's 16,384-byte contract events limit (docs/adr/0012).
- 2026-11-01 — `create_escrows` now works for batches of more than one item, and stays atomic.
  `MAX_BATCH_SIZE` drops from 50 to 16 in the contract and the SDK, because 24
  items exceed Mainnet's contract events limit. See the amended consequences in
  `docs/adr/0012-batch-settlement-best-effort.md`.
- 2026-11-01 — Added contract tests for the five mutants the nightly mutation run missed: the
  `create_escrows` batch limit, a pooled `condition_ref` of exactly 64 bytes, no
  fee transfer when the fee is zero, and `settle_many` at exactly `release_time`.
  Tests only, so no contract change.
- 2026-11-01 — Restored the SDK's batch helpers (`createEscrows`, `settleMany`,
  `BatchPartialFailureError`, `MAX_BATCH_SIZE` and the related types), which #248
  removed by accident when it merged from a stale branch, and put
  `tests/batch.test.ts` back in `test:offline` so CI catches this if it happens
  again. No contract change, so the generated bindings are unchanged.
- 2026-11-01 — Nightly soak: failures are now classified correctly. The old check matched bare
  words such as "network", which `tests/network-presets.test.ts` always printed,
  so every failure was reported as `INFRASTRUCTURE_FAILURE`. Added a
  `DEPLOYMENT_OUTDATED` result for a contract whose function arguments no longer
  match the SDK. The live suite now reads its contract id from `deployments.json`
  through `knownContractId("testnet")`, or from `TESTNET_CONTRACT_ID`.
- 2026-11-03 — Redeployed contract 2.5.1 to testnet as
  `CAANBNO7UXU24RVORQSGV33VJ7ZPL4UQKQNGPOSCSDDLISQ35SH62Y6E` with `scripts/deploy`
  (source `52a6a39`), so the deployment now matches the SDK's `create_escrow` and
  has the emergency pause. All six scripted live checks passed; `pause_admin` is
  `GDJBRSDH4OARYUYDUDUXYTELZQMIJVZBLL4H2CDQFOHMNKNGE4ILUM7T`. The SDK testnet
  preset, README and `fees.test.ts` now use the new id. Exercising
  `pause`/`unpause` live, including a release while paused, is still open under
  Phase E5. docforum-core stays on its own older contract and SDK 0.2.0 for now.
- 2026-11-04 — Issue #103 (Phase E4): added `tests/reentry_intermediate.rs`, which proves re-entry through an intermediate contract fails closed for `release`, `refund` and `create_escrow`, including against a different escrow id. No contract change. The threat model's T4 section now records the result, replacing a coverage claim that had no test behind it.
- 2026-11-04 — Issue #52 (Phase E5): the SDK can now read the contract's version on first use and check it against `>=2.0.0 <3.0.0`, the range that has the `create_escrow` arguments it sends. Older deployments with no `version()` are reported as `null` and handled without an opaque error. `docs/testnet-deployments.md` now records each deployment's version.
- 2026-11-05 — Raised the time limit for `sdk/tests/testnet-integration.test.ts` from 60 to 120 seconds, because the longest live tests were timing out on a slow testnet and failing the nightly soak. Other SDK tests keep their 60-second limit.
- 2026-11-11 — Fixed the weekly Futurenet compatibility check, which had failed since the contract gained a constructor: its deploy step now passes `allowed_tokens` (empty, so any token is allowed) and `pause_admin` (the run's own funded identity).
- 2026-11-18 — Issue #10 (Phase E4, threat model T6): extend contract instance TTL on every call (~30 days, threshold ~7 days) and escrow entry persistent TTL on creation (~180 days default or deadline + 30-day grace, threshold ~30 days). Write paths (`top_up`, `rotate_releaser`, `accept`) extend entry TTL; settlement paths (`release`, `refund`) maintain a 30-day post-settlement audit retention window. Confirmed `NextId` continuity and non-reuse across archival. Added test suite in `contracts/escrow/tests/ttl.rs`, updated `ARCHITECTURE_ESSENTIALS.md § Storage TTL & Archival`, marked T6 mitigated in `docs/threat-model.md`, and updated `ROADMAP.md`.
- 2026-11-18 — Added explicit Soroban authorization trees for escrow creation, including its nested token transfer, and for release/refund tests. This is an incremental part of issue #105; other contract test modules still use permissive auth mocks.
- 2026-11-18 — Issue #15 (Phase E4): added a "Trust model for integrators" section to
  `README.md` covering the four properties integrators need before relying on a
  `Funded` escrow: releaser control rather than payee commitment (T8), checking
  the escrow's token rather than only its status (T5), the public and permanent
  nature of `condition_ref`/`payer`/`payee`/`amount` (T9), and pinning the
  caller-supplied `contractId` against the deployment record. Also documented the
  same `condition_ref` privacy warning on `EscrowData`/`create_escrow` in
  `contracts/escrow/src/lib.rs` and on `createEscrow` in `sdk/src/index.ts`.
  Docs only — no contract or SDK behavior change. Because the contract's doc
  comments are part of its on-chain spec, `sdk/src/generated/contract-client.ts`
  was regenerated with the pinned Stellar CLI; review it as generated output, not
  a hand edit.
- 2026-11-18 — Issue #22 adds immutable split recipients to escrow creation. Release deducts any
  protocol fee first, distributes the remaining amount by basis-point shares,
  and sends rounding remainder to the final recipient. Refund destinations and
  authorization rules are unchanged.
- 2026-11-18 — Issue #41 (Phase E5): mutually consented refund deadline extension, ADR 0004.
  `extend_refund_after(escrow_id, new_deadline)` moves a `Funded`,
  single-releaser escrow's `refund_after` later, requiring both the payer's
  and the releaser's authorization. Rejects a missing deadline, a deadline
  that has already passed, or a proposed deadline that is not strictly later.
  Emits `refund_deadline_extended`. New error `InvalidRefundExtension` (code
  35, appended after the pooled-escrow variants so their discriminants keep
  their on-chain values). SDK `client.extendRefundAfter()` accepts any
  `EscrowSigner` for both parties; bindings regenerated. Not yet on testnet.
- 2026-11-18 — Issue #44 (Phase E5): added fixed-total linear vesting streams
  (`create_streamed_escrow`, `withdraw`, `get_vesting`; ADR 0012). The payee
  withdraws vested funds while the escrow is funded; `release` pays whatever is
  still unwithdrawn; a refund splits vested-but-unwithdrawn funds to the payee
  and the unvested remainder to `refund_to`. Streams reject `top_up`. New
  contract errors 35–39 are appended after main's codes. The generated SDK
  bindings were regenerated.
- 2026-11-18 — Issue #46 (Phase E5): added `settle(escrow_id, caller, payee_amount)`. A single
  releaser pays `payee_amount` (0 to the full amount) to the payee and the rest to the
  escrow's `refund_to`. Quorum escrows must use the approval path. The split applies the
  same release-time and payee-acceptance gates as `release`, and pooled escrows are rejected
  (`NotSupportedForPooled`). Out-of-range amounts return the new `InvalidSettlementAmount` (35).
  Contract bindings regenerated; the TLA+ spec under `spec/` does not model `settle` yet.
- 2026-11-18 — Issue #48 (Phase E5), `docs/adr/0013`: settled escrows (released, refunded or cancelled) are reclaimed from persistent storage and reduced to its `Status` entry; the existing `ESCROW` state event is the history. `get_status` still answers for settled ids (`NotFound` now means "never created"), `get_escrow` returns `NotFound` once settled, and mutating calls on a settled id still return `NotFunded`. Pooled escrows keep their full record (their contributions and refunds read it). Needs a contract redeploy and an SDK release.
- 2026-11-18 — Issue #58 (Phase E6): the SDK can split signing from building and submitting. `prepareCreateEscrow` builds and simulates an unsigned `create_escrow` for a public key, bounded by ledger bounds; `submitSigned` verifies the hash, expiry and source sequence, optionally fee-bumps under a hard cap, and polls to completion. SDK minor; no contract change.
- 2026-11-18 — Issue #59 (Phase E6): offline signing for release and refund. `prepareRelease` / `prepareRefund` build an unsigned transaction for a cold or classic-multisig releaser (about a one-day window), `mergeSignatures` combines separately signed copies, and `signAuthEntries` covers a hot fee payer with a cold releaser. Staleness (moved sequence, expiry) is detected before sending. Example scripts in `examples/offline-release/`. SDK minor; no contract change.
- 2026-11-18 — Issue #61 (Phase E6): the SDK now surfaces failures as typed `EscrowError`
  subclasses. Contract rejections carry their numeric `code` and a named class
  (`NotFoundError`, `UnauthorizedError`, `NotFundedError`, …); codes without a
  dedicated class fall back to a generic `ContractError`. Simulation,
  submission, timeout and network-passphrase mismatch failures have separate
  classes, and the original exception is kept as `cause`. The code→name
  mapping in `sdk/src/contract-errors.generated.ts` is generated from the Rust
  `Error` enum and checked for drift in CI. Consumer migration notes live in
  `docs/sdk-errors.md`.
- 2026-11-18 — Issue #79 (Phase E6): published SDK API reference and runnable examples.
  Added `sdk/typedoc.json` to generate an HTML reference for every exported
  symbol, with a missing-doc lint — `npm run docs` fails on undocumented
  exports, broken doc links, or unexpectedly non-exported types
  (`treatValidationWarningsAsErrors`). Added doc comments to the exported
  symbols that lacked them. New `sdk/examples/` directory with one runnable,
  secret-free script per major flow (create/release, timeout refund, M-of-N
  quorum, and the estimate → prepare/sign → guard → fee-bump → submit
  sponsorship flow): every keypair is generated at runtime and Friendbot-funded,
  testnet only. CI type-checks the examples (`typecheck:examples`) and adds an
  `sdk-docs` job; a new `.github/workflows/docs.yml` publishes the reference to GitHub Pages
  (enabling Pages is a one-time human step). Docs-only: no contract or SDK API
  change, so the generated bindings and the SDK version are unchanged.
- 2026-11-18 — Contract 3.0.0 (was 2.5.1), folded from 7 change(s):
  - Issue #10: storage TTL management (threat model T6). Every entry point extends the instance TTL; escrow and status entries are extended to at least ~180 days or through `refund_after` plus a 30-day grace (capped at the network maximum), and settled escrows keep a shorter TTL. `DataKey` is now public so tests can inspect entry TTLs.
  - Issue #15: doc comments only. `condition_ref` on `EscrowData` and `create_escrow` now warns that it is public on-chain forever and must be an opaque id (docs/threat-model.md T9). No behaviour or interface change; the SDK bindings pick up the new doc text.
  - Issue #22: split payouts (ADR 0014). New `create_split_escrow` releases one escrow to up to `MAX_PAYEES` (8) payees by basis points (unique recipients, shares totalling 10 000 bps, rounding dust to the last payee; fees come off first). `EscrowData` gains a `payees` list (a single entry for ordinary escrows). New errors `InvalidPayeeList`, `TooManyPayees`, `DuplicatePayee`, `InvalidBasisPoints`, `SplitAmountOverflow` (41-45). Each share is sent with the same checked transfer as ordinary releases (`Undeliverable` on failure).
  - Issue #41: let the payer and first releaser jointly extend an active single-releaser escrow refund deadline, with a dedicated update event and visible deadline in escrow reads.
  - Issue #44: add fixed-total linear vesting escrows with start/end/cliff schedules, payee withdrawals, and settlement that routes unpaid vested value to the payee and unvested value to the stored refund destination.
  - Issue #46: releaser-authorized split settlement. New `settle(escrow_id, caller, payee_amount)` pays a chosen gross amount to the payee and returns the rest to `refund_to`, under the same release-time and acceptance gates as `release`. A protocol fee applies to the payee share only, never to the refunded part (ADR 0010), so `settle(0)` matches `refund` and `settle(amount)` matches `release`. Streamed and multi-payee escrows are rejected with `SettlementNotSupported`. New errors `InvalidSettlementAmount` (52) and `SettlementNotSupported` (53).
  - Issue #48: reclaim storage for settled escrows (docs/adr/0013). Settling a non-pooled escrow removes its full `EscrowData` record and keeps only the `Status` entry (whose TTL is extended as before); `get_escrow` on a settled id now returns `NotFound` and mutating calls return `NotFunded`. Pooled escrows keep their full record, and a settled stream stays readable through `get_vesting`. Breaking for callers that read `get_escrow` after settlement; the SDK accepts contract 3.x (`SUPPORTED_CONTRACT_VERSIONS` < 4.0.0).
  Final error codes: Error::InvalidSettlementAmount 4600 -> 52, Error::SettlementNotSupported 4601 -> 53, Error::InvalidPayeeList 2200 -> 41, Error::TooManyPayees 2201 -> 42, Error::DuplicatePayee 2202 -> 43, Error::InvalidBasisPoints 2203 -> 44, Error::SplitAmountOverflow 2204 -> 45, Error::PoolInsufficient 4400 -> 47, Error::NotStreamed 4401 -> 48, Error::InvalidVestingSchedule 4402 -> 49, Error::NothingToWithdraw 4403 -> 50, Error::StreamTopUpUnsupported 4404 -> 51, Error::InvalidRefundExtension 4100 -> 46.
- 2026-11-19 — Redeployed contract 3.0.0 to testnet as
  `CB7WHNBNHEVPFTGDOWHFMDOWKLTA2Z4CBR3KZGYIVSSJNUT3OGWYSW2H` with `scripts/deploy` (source `2bbc6b1`).
  All six scripted live checks passed; `pause_admin` is
  `GDJBRSDH4OARYUYDUDUXYTELZQMIJVZBLL4H2CDQFOHMNKNGE4ILUM7T` and `version()`
  reports `3.0.0`. The SDK testnet preset, README and SDK tests now use the new
  id. The 2.5.1 deployment `CAANBNO7UXU24RVORQSGV33VJ7ZPL4UQKQNGPOSCSDDLISQ35SH62Y6E` stays
  recorded in `docs/testnet-deployments.md`.
- 2026-11-19 — Contract 3.0.1 (was 3.0.0), folded from 1 change(s):
  - No behaviour or interface change: `contracts/escrow/src/lib.rs` is split into one module per area (`create.rs`, `pooled.rs`, `release_refund.rs`, `errors.rs`, …) so contract PRs stop editing the same file. The contract spec is entry-for-entry identical; only the WASM's internal function and spec-entry order changes, so the WASM hash differs from 3.0.0.
- 2026-11-19 — Shared docs now take new content as fragments: a PR adds a file under
  `docs.d/` naming the doc and the heading (or line) its text goes under,
  instead of adding lines to `ROADMAP.md`, `ARCHITECTURE_ESSENTIALS.md`,
  `README.md` or `docs/threat-model.md`. Maintainers fold them with
  `node scripts/docs-fragments.mjs fold`. The new `Docs fragments` CI job fails
  PRs that add lines to those docs directly or whose fragments don't fold.
- 2026-11-19 — Generated files (SDK bindings, `contract-errors.generated.ts`,
  `deployments.generated.ts`, `contract-spec.json`, contract test snapshots) are
  marked `linguist-generated` in `.gitattributes`, so GitHub collapses them in PR
  diffs; each entry names the command that regenerates it. CI now also checks
  that `sdk/src/deployments.generated.ts` matches `deployments.json`.
- 2026-11-19 — The SDK's `src/index.ts` no longer holds every public type: its top-level types,
  constants and errors moved into topical modules (`escrow-types`, `events`,
  `milestones`, `networks`, `contract-version`, `batch`, `client-config`,
  `lifecycle`, `pooled`, `relayed-auth`, `prepare-submit`, `fees`,
  `archived-entries`), re-exported from `index.ts`, which keeps the
  `EscrowClient` class. Private helpers shared between them are in
  `internal.ts`. The package's exports are unchanged (all 170, with identical
  types).
- 2026-11-19 — Threat model IDs are unique again. Parallel PRs had each numbered their new
  threat T11 or T12, leaving five T11s (one a duplicated copy of the release
  callback) and three T12s. Renumbered: deployments T20, `refund_to` T21, payee
  key T22, planned Phase E5 features T23, front-running `cancel` T24; T11 stays
  the release callback and T12 the pause custodian. References across the docs
  point at the right threat, and new threats now use a provisional `T<issue>`
  ID until a maintainer folds them.
- 2026-11-20 — CI: fork PRs' workflow runs are now approved automatically once they pass
  security review (`PR CI auto-approval`, the same workflow docforum-web uses
  since #350). The workflow runs after `PR malware scan` succeeds. It re-runs
  the scanner, then checks the diff and every commit in the PR's history for
  workflow, editor-config, font, payload-loader, npm-script, lockfile
  (npm/crates.io) and Go `replace` changes, and requires every commit to come
  from the PR author, a known AI coding tool account or a GitHub update merge. A
  PR that fails any check is labelled `ci-needs-manual-approval` and waits for a
  maintainer, as before.
- 2026-11-21 — Issue #293 (Phase E5): added bounded read-only `get_escrows(ids)` and
  `next_escrow_id()` views, with `None` for unknown or archived records and a
  measured cap for batch reads.
- 2026-11-21 — Issue #294 (Phase E5): added `rotate_releaser_with_approvals` so a quorum
  escrow can replace one releaser with `threshold` member approvals plus the
  payer's consent. The outgoing member's approval counts toward the
  threshold. Tests in `contracts/escrow/tests/releaser_rotation.rs`. The
  generated SDK bindings need regenerating from the new contract interface.
- 2026-11-21 — Issue #299 (Phase E5): added read-only `get_allowed_tokens()` to the contract,
  returning the immutable deploy-time token allowlist (`Vec<Address>`; empty
  means any token). Integrators can now verify a deployment's accepted tokens
  on-chain instead of trusting deployment notes. No new storage or error codes.
  The SDK gains `getAllowedTokens()` and the generated bindings were
  regenerated from the WASM.
- 2026-11-21 — Issue #300 (Phase E4): documented the allowed self-dealing role overlaps in
  the threat model and added regression coverage for every pair in the matrix.
  No contract behavior changed.
- 2026-11-21 — Issue #308 (Phase E7): added a second cargo-fuzz target,
  `contracts/escrow/fuzz/fuzz_targets/settlement.rs`, for quorum settlement
  and `settle_many`. It creates escrows with arbitrary releaser sets and
  thresholds, then drives `release_with_approvals` / `refund_with_approvals`
  with arbitrary approver lists (duplicates, non-members, short lists) and
  `settle_many` with arbitrary op vectors (repeats, unknown ids, lengths past
  `MAX_SETTLE_OPS`). After every step it asserts fund conservation, at most
  one payout per escrow, and that a rejected call or op leaves its escrow
  untouched; each call's outcome is also checked against a model of the
  ADR 0007 / ADR 0012 rules. Seed corpus in `fuzz/corpus/settlement/`. The
  `contract-fuzz` CI job now builds and runs both targets, splitting the old
  budget (15 s each on PRs, 300 s each nightly). No contract or SDK change.
- 2026-11-21 — Issue #310 (Phase E7): extended `contracts/escrow/tests/top_up.rs` and
  `contracts/escrow/tests/sponsored_refund.rs` with coverage for `top_up` on a
  quorum escrow, after payee acceptance, on a `release_not_before` escrow, a
  sponsor (`refund_to`) attempting a top-up (`Unauthorized`), and the refund
  after a top-up returning the full new total to `refund_to`. The refund test
  asserts both the `refund_to` balance and the `solvency` liability counter.
  The T13 (top-up landing after a release is approved) case is named
  explicitly in the acceptance test. Tests only: no contract or SDK surface
  change, so no `contract-changes.d/` fragment and unchanged generated
  bindings.
- 2026-11-21 — Issue #317 (Phase E7): extended the formal-verification spike with the
  pooled-escrow accounting rules (I4, ADR 0011) and fee-conservation rules
  (I7, ADR 0010). `certora/escrow.spec` now states exact-balance inbound
  transfers, contribution recording only after verification, the
  `amount == Σ unclaimed contributions` aggregate, `claim_refund` paying the
  recorded amount exactly once, a pooled `release` requiring
  `amount == funding_target`, fee + payout summing to the stored amount on
  release, the fee being charged on the split payee share, and refund/cancel
  paths never paying `fee_recipient`. `docs/formal-verification.md` records the
  new scope, the error discriminants relied on, and the honest status: still
  specified, not machine-checked — no Certora run is attached. No contract or
  SDK surface changed, so there is no contract-changes fragment, bindings
  regeneration or version bump.
- 2026-11-21 — Issue #323: the SDK now rejects protocol-fee options combined with
  `requiresAcceptance` before attempting to build or simulate a transaction.
- 2026-11-21 — Issue #325 (Phase E6): added `EscrowClient.transferPayee({ escrowId, currentPayee, newPayee })` to the SDK, wrapping the contract's `transfer_payee`. It accepts a `Keypair` or SEP-43 signer for the current payee, pre-checks client-side that the escrow is `Funded` and that `newPayee` is neither the payer nor the contract id (`EscrowPreconditionError` with code `InvalidNewPayee`, matching contract error 37), and is carried by `prepareLifecycleCall` as method `transfer_payee`. Offline tests added in `sdk/tests/lifecycle.test.ts`. No contract change, so the generated bindings are unchanged.
- 2026-11-21 — Issue #33 (Phase E5): decided how to list escrows by payer or payee (ADR 0015).
  Chosen: off-chain. The contract is unchanged — the `ESCROW` event (issue #9)
  already carries `payer`/`payee` and the issue #87 indexer already stores them, so
  there is no `list_by_payer` / `list_by_payee` and no redeploy.
  `EscrowIndexerClient.listEscrows` gained optional `payer`/`payee` filters that
  pass through to the indexer's existing fields (SDK minor, additive); its test
  now runs in the offline CI job.
- 2026-11-21 — Issue #68 (Phase E6): added a Python client SDK in `sdk-python/` (package
  `docforum_escrow`, `stellar-sdk` 17, Python 3.10+). It wraps `create_escrow`,
  `get_status`, `get_escrow`, `release` and `refund` with a thin hand-written
  client whose arguments are checked against `contract-spec.json` in the unit
  tests. Contract errors are typed, one class per code, named like the TS SDK's
  and checked against `contract-spec.json`, `errors.rs` and the TS generated
  map. i128 amounts are Python `int` with range checks. Offline unit tests run
  in the new `.github/workflows/sdk-python.yml`; the live testnet suite
  (`ESCROW_INTEGRATION=1 pytest -m integration`) stays out of CI like the TS
  SDK's. No PyPI publish yet: the plan is in `sdk-python/README.md`. No
  contract change.
- 2026-11-21 — Issue #78 (Phase E6): added `checkSolvency({ contractId, tokens })` to the SDK, returning balance vs liabilities per token from the on-chain `solvency` view, with an events-based fallback for deployments that predate it, plus a `check-solvency` CLI command that exits 1 on a shortfall. No contract change, so the generated bindings are unchanged.
- 2026-11-21 — CI: `Docs fragments` now fails only when a PR adds lines straight to a shared
  doc, which is the rule that prevents conflicts. A fragment that wouldn't fold
  (unknown heading, ambiguous `after:`, missing front matter) is a warning with a
  suggested fix (closest headings, or the shared doc that has the heading), shown
  inline on the PR, and a maintainer corrects it when folding. Problems in
  fragments already on main are never blamed on a PR. Maintainer mode (fold PRs)
  stays strict. Same change as docforum-web#364.
- 2026-11-21 — PR malware scan: flags unsigned commits that are attributed to a maintainer account (anyone with write access) on PRs opened by someone else, as the `unverified-maintainer-identity` note. Signed commits and web-flow merges pass; write access is read from the API, so the script stores no names or emails.
- 2026-11-22 — Tests now compare complete Soroban authorization trees, including nested
    token transfers, and cover a wrong-signer creation attempt.
- 2026-11-22 — Issue #286 (Phase E5): `transfer_payee` now resets `notify_payee = false` on transfer so that reassigning payout rights to an account or a contract without the callback hook cannot leave the escrow permanently unreleasable with `CallbackFailed`. Transferred escrows receive standard push token releases.
- 2026-11-22 — Issue #302 (Phase E5): the custom releaser account now authorizes exactly one
  `rotate_releaser` context for its configured escrow when the account is the
  current releaser. Rotation consumes one per-window operation slot and still
  requires the payer's separate escrow authorization; unit and integration
  coverage includes rotating and settling from the replacement releaser.
- 2026-11-22 — Issue #303 (Phase E5): Releaser account now stores rate-limit window counters in temporary storage with a TTL of the window length plus a small margin, so past windows no longer pay persistent rent or accumulate forever. `window_usage(window)` returns 0 for an expired counter instead of trapping. Existing deployments keep the previous persistent-counter behaviour.
- 2026-11-22 — Issue #313 (Phase E7): added a pause-test classification for every public
  contract entry point and compare it with `contract-spec.json`, so a new
  deposit path cannot silently bypass the pause guard.
- 2026-11-22 — Issue #316 (Phase E7): extended the TLA+ escrow model with the `Cancelled`
  terminal state, payer cancellation before acceptance, current-payee transfer,
  payee conservation, and explicit cancel/release mutual exclusion. Updated the
  model documentation and TLC configuration; no contract or SDK surface changed.
- 2026-11-22 — Issue #96 (Phase E7): contract interface snapshot and breaking ABI guard. Added committed `contract-spec.json` parity check, append-only error code enforcement, and interface change classification (additive vs breaking) requiring semver bump notes.
- 2026-11-22 — Contract 3.1.0 (was 3.0.1), folded from 5 change(s):
  - Issue #286: `transfer_payee` resets `notify_payee = false` so that reassigning payout rights to a new payee (account or contract) cannot render the escrow permanently unreleasable with `CallbackFailed`.
  - Issue #293: add the read-only `get_escrows(ids)` batch getter and `next_escrow_id()` counter view. The batch is capped at `MAX_GET_ESCROWS` and does not change settlement behavior.
  - Issue #294: quorum releaser rotation (ADR 0009). New `rotate_releaser_with_approvals` entry point; no existing entry point or error changes.
  - Issue #298: correct public escrow contract documentation and ADR references; the contract behavior and public entry-point signatures are unchanged, but the WASM spec and generated SDK documentation are refreshed.
  - Issue #299: new read-only `get_allowed_tokens() -> Vec<Address>` returning the immutable deploy-time token allowlist; an empty list still means any token is accepted. No new storage key and no new error code — the constructor already wrote `DataKey::AllowedTokens`, this only exposes it to integrators.
