# Threat model — `docforum_escrow` contract + `@docforum/escrow-sdk`

Status: **Draft, self-written. Not a review.** Part of issue #6 (Phase G4).
Written by the contract's implementer, so per issue #6 it does **not**
satisfy the "external or community review" half of E4. Its job is to give
an independent reviewer a map of where to look and what the author
already believes is weak.

Scope: contract source at commit `5a455fb` (`contracts/escrow/src/lib.rs`),
the TypeScript SDK (`sdk/src/index.ts`), and the one known consumer
pattern (custodial, as `docforum-core` uses it today). The live testnet
deployment is listed in `docs/testnet-deployments.md`.
Updated 2026-10-07 for the issue #12 balance-delta check and
mock-token tests (§1 I4, T4, T5, §6).

**Updated 2026-10-08 for issue #11 (Phase E4): the timeout refund path
from T2's candidate list was decided in `docs/adr/0004` and implemented
(`refund_after` + `get_escrow`), so T2, T8 and the §6 checklist below now
reflect that. The scope commit above predates the change; everything else
in this document still describes the same design.*

**Updated 2026-10-09 for issue #16 (Phase E5): `settle_many` batch
settlement was added (`docs/adr/0005`). The T1 response guidance below
now describes batching. I1, I2 and I3 are unchanged — a batch op only
ever sends to the stored `payee`/`payer`, and auth is still per-op.**

---

## 1. What the contract is supposed to guarantee

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Funds only leave an escrow to that escrow's `payee` (on release) or `payer` (on refund). No other destination exists. | Destinations are read from storage, never from call arguments (`lib.rs:165`, `lib.rs:203`). The `refund_after` timeout path (issue #11, ADR"0004) adds a new *caller*, not a new destination. `settle_many` (issue #16, ADR 0005) is the same: an op only ever sends to the stored `payee`/`payer`. |
| I2 | Only the escrow's `releaser` can move funds out — or, once `refund_after` has passed, anyone at all, and then still only back to `payer`. | `settle_many` applies the same per-op check as the single-op functions: `settle_one` checks `caller == data.releaser` for a release, and `caller == data.releaser || timeout_passed` for a refund (`lib.rs`). Auth is per-op, never per-batch. |
| I3 | Each escrow pays out at most once. | `status == Funded` check before transfer, status written after — shared by release, both refund paths, and `settle_one`. The same escrow twice in one batch fails the second op `NotFunded` (`tests/settle_many.rs`). |
| I4 | An escrow only exists if `amount` was actually transferred in. | `payer.require_auth()` + token `transfer` before the escrow is stored (`lib.rs:96-112`). |
| I5 | The contract never interprets `condition_ref`. | No code reads it after storage (ADR 0001). |

I1 is the most important property in this design. A full compromise of the
`releaser` key lets an attacker pick the **wrong outcome** (release when
it should refund, or the reverse). It does **not** let them redirect funds
to an address they control, unless they already control the `payee` or
`payer`. Neither does the timeout: it can only hand funds back to the
payer, so the worst case there is an escrow ending early, not funds going
somewhere new. The same holds for `SettleOp::Release`/`::Refund` inside
`settle_many` — an op is just a single-op call with a batch-friendly
return type.

## 2. Assets and actors

**Assets:** tokens held by the contract address, summed across every
escrow; the integrity of each escrow's stored `EscrowData`.

| Actor | Can do | Trusted for |
|---|---|---|
| `payer` | Create escrows by funding them; chooses `payee`, `token`, `releaser` | Nothing after creation. Has no on-chain power to cancel. |
| `payee` | Receive funds | Nothing. Has **no on-chain power at all**, including no way to object to a refund. |
| `releaser` | `release` or `refund` its escrows, once; or settle many of them in one `settle_many` call. | Choosing the correct outcome. This is the main trust assumption. |
| `token` contract | Executes transfers | Behaving like a standard SEP-41 token (see T5). |
| Anyone | Call `create_escrow` with their own funds, call `get_status`/`get_escrow`, and — on an escrow whose `refund_after` has passed — call `refund`, which can only send funds back to that escrow's `payer` | Nothing. (The timeout refund can also be exercised through `settle_many`, with the same destination rule.) |

There is **no admin, no upgrade function, and no pause.** The deployed
WASM is immutable. Nobody, including the deployer, can change an
escrow's data or move funds outside `release`/`refund`/`settle_many`.

## 3. Threats

Severity is the author's estimate for a mainnet deployment with real
value. **Reviewers should challenge these ratings.**

### T1 — `releaser` key leaked or stolen · **High**
- **What an attacker can do:** call `release` or `refund` on every
  still-`Funded` escrow whose `releaser` is that key, picking either
  outcome. Funds still only go to the stored `payee`/`payer` (I1).
- **Actual loss:** if the attacker also controls a `payee` address (for
  example a payee who colludes, or who got a fraudulent payee address
  recorded by the consumer), they can release that payee's escrows early
  and keep the funds. Otherwise the damage is wrong outcomes, not theft.
- **Blast radius in practice:** ADR 0002 picked per-escrow releasers to
  limit blast radius. But the custodial consumer (`docforum-core`,
  its ADR 0004) uses **one** `PLATFORM_RELEASER_SECRET` as the releaser of
  every escrow it creates. So today one leaked key affects every open
  escrow. The scoping benefit is available, but nobody uses it.
- **Recovery:** none on-chain. You can't rotate a `releaser` on an
  existing escrow (no setter exists). The only response is to race the
  attacker: use the same key to settle every open escrow correctly first.
  **Update (issue #16, ADR"0005):** that race is now meant to be run in
  batches. `settle_many` lets one transaction settle up to
  `MAX_BATCH_SIZE` (=20) escrows, and it is **best-effort**: an op
  the attacker already won fails `NotFunded` and the rest of the
  batch still lands. The response procedure is now: build a batch of
  every still-open escrow this key controls, settle it, then re-submit
  just the ops that failed for a recoverable reason (e.g. a
  transient token failure). Do not roll back the whole batch because
  one escrow is already lost.
- **Mitigations to consider:**
  - Make the `releaser` a Stellar multisig account (e.g. 2-of-3 signers).
    This works with no contract change, because `require_auth` on an
    account address checks that account's own signer thresholds.
  - Keep the releaser key in a KMS/HSM, not as an environment variable.
  - In the consumer, rotate releaser keys periodically for **new**
    escrows, so a leak only reaches escrows from that key's period.

### T2 — `releaser` key lost · **High for escrows created without a timeout; mitigated (still worth planning for) with one**
- **Effect (before issue #11):** every `Funded` escrow with that
  `releaser` was **locked forever** — no timeout, no fallback refund path,
  no admin and no upgrade. Funds stayed in the contract address
  permanently.
- -**Effect (now):** escrows created with a `refund_after` deadline can be
  recovered by **anyone** after it passes — always back to the `payer`
  (`docs/adr/0004`, implemented in issue #11). Escrows created *without*
  one (still the default, and what `docforum-core` passes today) keep the
  original behaviour: locked forever. The permanent-lock failure mode is
  removed from the contract, not from the call sites that decline to use
  it.
- -**Same applies to:** a `releaser` that can never sign. For example, the
  contract's own address, or an address typed incorrectly at creation.
  `create_escrow` does not validate `releaser` beyond its type.
- -**Mitigations (contract changes need tests per hard rule 2):**
  - [x] An optional `refund_after` timestamp set at creation. After it
    passes, anyone can trigger `refund` back to `payer` — **done**,
    decided in `docs/adr/0004` and implemented in issue #11 (tests in
    `tests/timeout_refund.rs`). Note the accepted consequence: after the
    deadline the escrow can end early *by anyone*, so a payee must read
    the deadline first (see T8).
  - [] Reject `releaser == current_contract_address()` and
    `payee == current_contract_address()` in `create_escrow`.
  - [] Operationally: back up the releaser key, or use a multisig as in
    T1, which also covers loss of one signer. Callers should pass a
    `refund_after` sized to their longest plausible fulfillment window.

### T3 — Double-spend / double payout · **Low (believed mitigated)**
- `release`/`refund` check `status == Funded` and fail with `NotFunded`
  otherwise. Tests cover double-release, release-after-refund, and
  refund-after-release (`tests/release_refund.rs`). `SettleOp` in a
  `SettleMany` batch goes through the same check, including the
  same escrow twice in one batch (`tests/settle_many.rs`).
- Concurrent transactions: Soroban applies transactions in a ledger one
  after another. Both would touch the same storage key, so the second
  one sees the updated status and fails. This is also true between a
  `settle_many` call and a single-op call.
- Auth replay: Soroban auth entries carry a nonce and an expiration
  ledger, so a captured signed `release` can't be replayed on another
  escrow (the `escrow_id` is part of the signed invocation) or reused.
  The same applies to a `SettleMany` invocation: the full op list is
  part of what is signed.
- -*Reviewer, please verify:** that no path writes a status other than
  through these functions, and that the status check can't be
  bypassed if the escrow entry is archived and then restored (see T6).

### T4 — Reentrancy · **Low (believed mitigated by the host), Informational**
- `release`/`refund` call the token's `transfer` **before** writing the
  new status (`lib.rs:128` then `lib.rs:131`). This is the classic
  "interaction before effect" order that causes reentrancy bugs on EVM.
- On Soroban, the host rejects a contract calling back into a contract
  that is already on the call stack. So a malicious `token` can't call
  `release` again mid-transfer. Also, if the transfer fails, the whole
  invocation rolls back, including the status write.
- **Recommendation anyway:** write `status` before calling `transfer`
  (checks-effects-interactions). It costs nothing. It also means safety
  doesn't depend on a host rule a reader might not know about.
- **Update (issue #12):** a test-only mock token that re-enters
  `release` from inside its `transfer` is rejected by the host with
  "Contract re-entry is not allowed" — an unrecoverable context error,
  so the entire release invocation aborts and nothing commits
  (`tests/malicious_token.rs`). This pins the behavior for the direct
  token→escrow path; the through-an-intermediate-contract path below is
  still open for reviewer verification. `settle_many` calls the
  same `transfer` path per op, so the same host rule applies.
- **Reviewer, please verify:** the host's re-entry prohibition applies
  to every path a SEP-41 token could use to reach this contract,
  including through an intermediate third contract.

### T5 — Malicious or non-standard `token` · **Medium**
`token` is any address the payer supplies. The contract trusts it to
behave like SEP-41.
- -*Lying token:** a token whose `transfer` succeeds without moving
  anything creates a `Funded` escrow backed by nothing. That only
  affects escrows *in that same fake token*. Other tokens' balances are
  separate, so this is mostly a problem for payees who trust the
  `Funded` status of a token they didn't vet.
- **Shared pool per token:** all escrows in the same token draw from one
  contract balance. If a token ever delivers less than `amount` (a
  fee-on-transfer, rebasing, or clawback-enabled asset), the contract
  holds less than the sum of its escrows in that token. Early payouts
  then use up later escrows' funds, and the last ones fail.
  - Stellar Asset Contracts for issued assets can have **clawback**
    enabled by the issuer. A clawback against the contract address
    removes funds from the shared pool.
- **Mitigations to consider:**
  - ~~In `create_escrow`, check the contract's token balance before and
    after the transfer, and reject (or record the real delta) if it
    doesn't rise by exactly `amount`.~| **Implemented (issue #12):**
    `create_escrow` now rejects with `BalanceMismatch` unless the
    contract's balance rose by exactly `amount` across the transfer
    (`lib.rs:89-94`). Catches the lying-transfer case above and the
    fee-on-transfer/rebasing short-delivery case at creation — both
    covered by mock-token tests (`tests/malicious_token.rs`). What it
    **cannot** catch is a token that takes funds back *after*
    creation: a clawback-enabled issuer can drain the shared pool
    later, and no creation-time check sees that. Accepted residual
    risk for now (documented, deliberately not solved here) — the
    practical mitigation stays with the consumer: allowlist only
    tokens without clawback, transfer fees, or rebasing.
  - Consumers: only use an allowlist of known tokens. The current
    consumer uses one configured token (`escrowTokenId`), which is good.
  - Document that payees must check the escrow s `token`, not just its
    status.

### T6 — Storage TTL + state archival · **Medium (operational)**
- The contract never calls `extend_ttl`. Escrow entries (persistent
  storage) and `NextId` (instance storage) will reach end of TWL and be
  **archived** if nothing extends them.
- Archived entries are not deleted, so funds are not lost. But
  `get_status`/`release`/`refund` on a
