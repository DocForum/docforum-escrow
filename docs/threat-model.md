# Threat model — `docforum_escrow` contract + `@docforum/escrow-sdk`

Status: **Draft, self-written. Not a review.** Part of issue #6 (Phase E4).
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

*Updated 2026-10-20 for issues #118/#119: §1 I2 and §2 now describe the
releaser set with a threshold instead of a single address; T1 and T2 record
the in-contract M-of-N mitigation and its limits; T4 records the
checks-effects-interactions change (now implemented); T8 tells payees to read
`releasers` + `threshold`; the §6 checklist item for T4 is closed.*

*Updated 2026-10-08 for issue #11 (Phase E4): the timeout refund path
from T2's candidate list was decided in `docs/adr/0004` and implemented
(`refund_after` + `get_escrow`), so T2, T8 and the §6 checklist below now
reflect that. The scope commit above predates the change; everything else
in this document still describes the same design.*

*Updated 2026-10-16 for issue #28 (Phase E5): optional `refund_to`, a
refund destination that may differ from the funder (`payer`), decided in
`docs/adr/0006`. Touches §1 (I1, I2), §2 (actors), T1, T2, T8, a new T11
and §6.*

---

## 1. What the contract is supposed to guarantee

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Funds only leave an escrow to that escrow's `payee` (on release) or the escrow's stored `refund_to` (on refund; equals `payer` unless a different one was set at creation). No other destination exists. | Both destinations are written once in `create_escrow` under the funder's auth and read from storage, never from call arguments (`lib.rs:165`, `lib.rs:203`). The `refund_after` timeout path (issue #11, ADR 0004) adds a new *caller*, not a new destination, and `refund_to` (issue #28, ADR 0009) is a second stored-at-creation destination, not a payout-time choice: nothing sets it after creation. |
| I2 | Only the escrow's releasers can move funds out — `threshold` distinct ones when the escrow was created M-of-N (ADR 0007); release additionally requires payee acceptance when configured — or, once `refund_after` has passed, anyone at all, and then still only to the stored `refund_to`. | `require_auth()` per caller/approver + membership in the stored `releasers` set + the threshold check (`check_single_caller`, `check_approvals`), relaxed solely by the deadline check in `refund`. Duplicate approvers are rejected. |
| I3 | Each escrow pays out at most once. | `status == Funded` check and terminal status write before transfer/callback; failures roll back atomically. |
| I4 | An escrow only exists, or grows, if the declared funds were actually transferred in. | `payer.require_auth()` + shared exact-balance-delta verification on create/top-up before storage is updated. |
| I5 | The contract never interprets `condition_ref`. | No code reads it after storage (ADR 0001). |

I1 is the most important property in this design. A full compromise of the
`releaser` key lets an attacker pick the **wrong outcome** (release when it
should refund, or the reverse). It does **not** let them redirect funds to
an address they control, unless they already control the `payee` or
`payer`. Neither does the timeout: it can only hand funds back to the
payer, so the worst case there is an escrow ending early, not funds going
somewhere new.

## 2. Assets and actors

**Assets:** tokens held by the contract address, summed across every
escrow; the integrity of each escrow's stored `EscrowData`.

| Actor | Can do | Trusted for |
|---|---|---|
| `payer` | Create escrows by funding them; chooses `payee`, `token`, `releaser`, and optionally a distinct `refund_to` — all under its single creation signature | Nothing after creation. Has no on-chain power to cancel. |
| `payee` | Receive funds; optionally accept an escrow before release | Without the opt-in acceptance gate, has no on-chain power to object to release or refund. |
| `releaser` (one address, or an M-of-N `releasers` set, ADR 0007) | `release` or `refund` its escrows, once — a quorum escrow needs `threshold` distinct releasers on one call | Choosing the correct outcome. This is the main trust assumption; a quorum splits it across the set. |
| `token` contract | Executes transfers | Behaving like a standard SEP-41 token (see T5). |
| Anyone | Call `create_escrow` with their own funds, call `get_status`/`get_escrow`, and — on an escrow whose `refund_after` has passed — call `refund`, which can only send funds to that escrow's stored `refund_to` | Nothing. |

There is **no admin, no upgrade function, and no pause.** The deployed
WASM is immutable. Nobody, including the deployer, can change an
escrow's data or move funds outside `release`/`refund`. This is a chosen
security property, not an unimplemented recovery mechanism: see
[`docs/adr/0005`](adr/0005-immutable-contract-and-redeploy-migrations.md)
for the redeployment and old-escrow settlement procedure.

## 3. Threats

Severity is the author's estimate for a mainnet deployment with real
value. **Reviewers should challenge these ratings.**

### T11 — Multiple contract deployments · **Medium (operational)**
- **What can go wrong:** after a redeployment, an integrator may query or
  operate only the newest contract ID and lose track of still-funded
  escrows held by an older deployment.
- **Impact:** old escrow records may be overlooked or remain unsettled;
  the new contract cannot migrate or recover them.
- **Mitigation:** retain the old contract ID, reconcile escrow records by
  deployment, and settle old escrows under their existing rules before
  retiring the old ID from writes. See ADR 0005. No upgrade key or
  migration hook is introduced to address this operational risk.

### T1 — `releaser` key leaked or stolen · **High**
- **What an attacker can do:** call `release` or `refund` on every
  still-`Funded` escrow whose `releaser` is that key, picking either
  outcome. Funds still only go to the stored `payee`/`payer` (I1).
- **`refund_to` does not widen this:** a stolen `releaser` can still only
  trigger a refund to the `refund_to` fixed at creation, never to an
  address of the attacker's choosing.
- **Actual loss:** if the attacker also controls a `payee` address (for
  example a payee who colludes, or who got a fraudulent payee address
  recorded by the consumer), they can release that payee's escrows early
  and keep the funds. Otherwise the damage is wrong outcomes, not theft.
- **Blast radius in practice:** ADR 0002 picked per-escrow releasers to
  limit blast radius. But the custodial consumer (`docforum-core`,
  its ADR 0004) uses **one** `PLATFORM_RELEASER_SECRET` as the releaser of
  every escrow it creates. So today one leaked key affects every open
  escrow. The scoping benefit is available, but nobody uses it.
- **Recovery:** a funded escrow can rotate its releaser when both the
  current releaser and payer authorize the change (issue #23, ADR 0009).
  Possession of the releaser key alone is insufficient to appoint an
  attacker. Rotation cannot undo a settlement that already landed, and
  it is unavailable if the payer cannot authorize. The timeout refund
  path remains the fallback for escrows whose releaser is unavailable.
- **Mitigations to consider:**
  - [x] Allow the current releaser and payer to rotate the releaser on a
    funded escrow (issue #23, ADR 0009); the payer's consent prevents
    compromised releaser key alone from redirecting future control.
  - Make the `releaser` a Stellar multisig account (e.g. 2-of-3 signers).
    This works with no contract change, because `require_auth` on an
    account address checks that account's own signer thresholds.
  - **In-contract M-of-N (implemented, issue #119 / ADR 0007):** create the
    escrow with `create_escrow_with_releasers(releasers, threshold)`. A
    single leaked key is then insufficient at `threshold > 1`; the attacker
    needs `threshold` distinct keys and must get all of them into one
    invocation. No separate account has to be administered, which removes
    the "one service key controls every escrow" pattern from the previous
    bullet. Limits: an attacker holding `threshold` keys is equivalent to a
    single stolen key today (collusion is not prevented, only made
    costlier), and the set is immutable — a compromised member cannot be
    removed from an existing escrow.
  - Keep the releaser key in a KMS/HSM, not as an environment variable.
  - In the consumer, rotate releaser keys periodically for **new**
    escrows, so a leak only reaches escrows from that key's period.

### T2 — `releaser` key lost · **High for escrows created without a timeout; mitigated (still worth planning for) with one**
- **Effect (before issue #11):** every `Funded` escrow with that
  `releaser` was **locked forever** — no timeout, no fallback refund path,
  no admin and no upgrade. Funds stayed in the contract address
  permanently.
- **Effect (now):** escrows created with a `refund_after` deadline can be
  recovered by **anyone** after it passes — always back to the `payer`
  (`docs/adr/0004`, implemented in issue #11). Escrows created *without*
  one (still the default, and what `docforum-core` passes today) keep the
  original behaviour: locked forever. The permanent-lock failure mode is
  removed from the contract, not from the call sites that decline to use
  it.
- **Same applies to:** a `releaser` that can never sign. For example, the
  contract's own address, or an address typed incorrectly at creation.
  `create_escrow` does not validate `releaser` beyond its type.
- **Mitigations (contract changes need tests per hard rule 2):**
  - [x] An optional `refund_after` timestamp set at creation. After it
    passes, anyone can trigger `refund` back to `payer` — **done**,
    decided in `docs/adr/0004` and implemented in issue #11 (tests in
    `tests/timeout_refund.rs`). Note the accepted consequence: after the
    deadline the escrow can end early *by anyone*, so a payee must read
    the deadline first (see T8).
  - [ ] Reject `releaser == current_contract_address()` and
    `payee == current_contract_address()` in `create_escrow`.
  - [ ] Operationally: back up the releaser key, or use a multisig as in
    T1, which also covers loss of one signer. Callers should pass a
    `refund_after` sized to their longest plausible fulfilment window.
  - [x] **M-of-N in the contract (issue #119 / ADR 0007):** a lost member
    no longer locks the escrow *if* the remaining set can still reach the
    threshold; if it cannot, the escrow behaves like a lost releaser and
    needs `refund_after`. This is a trade-off, not a cure: a 2-of-3 escrow
    with one lost key has no margin, and an M-of-N escrow with no deadline
    and too few available signers is still locked forever.

### T3 — Double-spend / double payout · **Low (believed mitigated)**
- `release`/`refund` check `status == Funded` and fail with `NotFunded`
  otherwise. Tests cover double-release, release-after-refund, and
  refund-after-release (`tests/release_refund.rs`).
- Concurrent transactions: Soroban applies transactions in a ledger one
  after another. Both would touch the same storage key, so the second
  one sees the updated status and fails.
- Auth replay: Soroban auth entries carry a nonce and an expiration
  ledger, so a captured signed `release` can't be replayed on another
  escrow (the `escrow_id` is part of the signed invocation) or reused.
- **Reviewer, please verify:** that no path writes a status other than
  through these two functions, and that the status check can't be
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
- **Implemented (2026-10-20, ADR 0006):** all four settlement paths go
  through `settle()`, which writes the settled status and then transfers.
  A failing payout rolls the whole invocation back, so an escrow cannot end
  up `Released`/`Refunded` with the funds still in the contract — pinned by
  `tests/malicious_token.rs::failed_payout_leaves_the_escrow_funded`. The
  host re-entry prohibition is now defence in depth, not the only control.
- **Update (issue #12):** a test-only mock token that re-enters
  `release` from inside its `transfer` is rejected by the host with
  "Contract re-entry is not allowed" — an unrecoverable context error,
  so the entire release invocation aborts and nothing commits
  (`tests/malicious_token.rs`). This pins the behavior for the direct
  token→escrow path; the through-an-intermediate-contract path below is
  still open for reviewer verification.
- **Reviewer, please verify:** the host's re-entry prohibition applies
  to every path a SEP-41 token could use to reach this contract,
  including through an intermediate third contract.

### T11 — Malicious or failing release callback · **Medium (payee opt-in)**
- A payee contract that authorizes `create_escrow` while
  `notify_payee` is true opts in to the callback. The payer cannot opt a
  payee in without its authorization. The payee can still make its callback
  expensive, return an error, or attempt to re-enter `release`, `refund`, or
  `create_escrow`.
- Callback errors fail `release` atomically (`CallbackFailed`); token movement
  and the `Released` state do not persist. The releaser can still refund, and
  anyone can refund after `refund_after`. Refund never invokes the payee.
- Soroban rejects re-entry while the escrow is already on the call stack.
  Tests in `tests/release_callback.rs` attempt all three state-changing
  entry points. A transaction budget exhaustion also fails release; the hook
  is synchronous and must stay bounded. The escrow makes one callback with
  fixed arguments and does not retry or loop.
- The payee must authorize creation when `notify_payee` is true. Only use it
  for a contract address implementing `on_escrow_released(u64, i128)`; a
  consenting address without the method cannot complete release. See ADR 0005.
### T5 — Malicious or non-standard `token` · **Medium**
`token` is any address the payer supplies. The contract trusts it to
behave like SEP-41.
- **Lying token:** a token whose `transfer` succeeds without moving
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
- **Mitigations:**
  - ~~In `create_escrow`, check the contract's token balance before and
    after the transfer, and reject (or record the real delta) if it
    doesn't rise by exactly `amount`.~~ **Implemented (issue #12):**
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
  - **Deploy-time token allowlist (issue #36):** the immutable
    `__constructor(allowed_tokens)` records approved token addresses, and
    `create_escrow` rejects any other token with `DisallowedToken` (error
    code 7). An empty list deliberately preserves the legacy allow-all
    behavior. Deployment operators must omit clawback-enabled, rebasing,
    and fee-on-transfer tokens from the list. This prevents callers from
    introducing arbitrary tokens but cannot stop an approved issuer from
    clawing back funds later. **Not yet on testnet:** the current live
    deployment predates the constructor.
  - Consumers: only use an allowlist of known tokens. The current
    consumer uses one configured token (`escrowTokenId`), which is good.
  - Document that payees must check the escrow's `token`, not just its
    status.

### T6 — Storage TTL / state archival · **Medium (operational)**
- The contract never calls `extend_ttl`. Escrow entries (persistent
  storage) and `NextId` (instance storage) will reach end of TTL and be
  **archived** if nothing extends them.
- Archived entries are not deleted, so funds are not lost. But
  `get_status`/`release`/`refund` on an archived entry need a restore
  first. The SDK defaults to surfacing `ArchivedEntryError`; consumers
  can opt into `archivalBehavior: "auto"` to use the Stellar SDK's
  restore preamble handling. A state-changing call's `payer` or `caller`
  pays the restore transaction. Read-only calls need a configured
  `restoreSigner`, which signs and pays for that transaction. The SDK
  allows one restore transaction per call and fails with a typed error
  if the retry still needs archived state.
- **Reviewer, please verify:** that an archived-then-restored `NextId`
  can't cause an escrow id to be reused, overwriting a live escrow. The
  author believes restore brings back the last written value, so ids
  stay unique, but this is the kind of thing an independent check should
  confirm.
- **Mitigation:** extend the escrow entry's TTL in `create_escrow` (and
  the instance TTL on each call), sized to the longest expected escrow
  duration.

### T7 — No events emitted · **Low**
- The contract publishes no events of its own. The only on-chain trace
  of create/release/refund is the token's `transfer` event plus storage
  changes. That makes it harder to monitor for T1 (an unexpected burst
  of releases from a leaked key).
- **Mitigation:** emit `created`/`released`/`refunded` events with the
  `escrow_id`. Alert in the consumer on any release/refund it didn't
  initiate.

### T8 — Payee has no protection against the releaser · **By design, document it**
- The `payer` chooses the `releaser`. Nothing stops `releaser == payer`,
  in which case the payer can refund themselves at any time. The escrow
  then gives the payee **no guarantee at all**.
- That's acceptable for a generic primitive (ADR 0001), but payees and
  integrators must understand: a `Funded` status means "the funds are
  locked under the stored `releaser`'s control." It does **not** mean
  "the funds are committed to me." A payee should check who the
  `releaser` is before relying on an escrow.
- **With the acceptance gate (issue #25, `docs/adr/0008`) the payer can
  still cancel until the payee accepts (issue #27, `docs/adr/0010`):** on an
  escrow with `requires_acceptance`, `Funded` plus `accepted_at == None`
  means the payer may take the funds back to `refund_to` at any moment;
  `accept` and `cancel` race and the first to land wins. Payees must call
  `accept` before relying on such an escrow. After acceptance `cancel` is
  closed for good. Escrows without the gate have no cancel.
- **With an M-of-N releaser set (issue #119, `docs/adr/0007`), what a payee
  must check changes:** fewer than `threshold` colluding releasers cannot
  settle early, but `threshold` colluding releasers can — read `releasers`
  and `threshold` together with `refundAfter` before treating a `Funded`
  escrow as a commitment.
- **With a `refund_after` (issue #11, `docs/adr/0004`), the commitment
  also expires:** after the deadline anyone can return the funds to the
  payer, so a payee must treat such an escrow as *time-bounded*. Read the
  deadline first — `get_escrow` on-chain, `client.getEscrow()` in the
  SDK — and require no deadline (or one well beyond your fulfilment
  window) from a `releaser` you trust if you need certainty. The
  direction of the new risk is bounded: the timeout path can only pay
  the payer, never a third party, and the releaser can still release
  after the deadline — so the realistic exposure is payment being delayed
  and then reversed, not redirected.
- **With a distinct `refund_to` (issue #28, `docs/adr/0006`), "reversed"
  means paid to `refund_to`, which may not be the payer.** The payee
  should read `refund_to` via `get_escrow` / `client.getEscrow()` along
  with `releaser` and `refund_after`. Note the funder may legitimately
  set `refund_to` equal to the payee (making a "refund" equivalent to a
  release) or to any third party; the destination is fixed at creation
  and visible, so this is a disclosed property of the deal, not a hidden
  one.

### T9 — `condition_ref` is public · **Low (privacy)**
- Everything in `EscrowData` is publicly readable on-chain forever,
  including `condition_ref`, `payer`, `payee` and `amount`. Hard rule 1
  (no sensitive data) depends entirely on consumers passing an opaque,
  meaningless id. The contract can't enforce it.
- The current consumer passes its own internal record id (a random
  identifier), which is fine. Payer/payee addresses and amounts are
  still linkable on-chain. That's inherent to a public ledger, not a bug.

### T10 — Storage spam · **Informational**
- Anyone can call `create_escrow` with tiny amounts and long
  `condition_ref` strings. The caller pays the rent for what they write,
  and `NextId` is a `u64`, so this isn't a meaningful attack. Listed so
  a reviewer doesn't need to rediscover it.
- **Mitigation (Phase E5):** `condition_ref` is bounded to 64 bytes and
  validated at creation (contract error `ConditionRefTooLong = 7`);
  the SDK also validates client-side via `MAX_CONDITION_REF_LENGTH`.
  64 bytes was chosen to fit a UUID (36 chars), a short urn identifier,
  or a human-readable label, while capping per-escrow storage and event
  payload cost. Current observed refs in tests are far shorter
  ("opaque-condition-ref", "sdk-integration-test-release"). Breaking
  for integrators passing longer refs — checked `docforum-core`'s usage
  pattern (opaque record id) and it stays well within the bound.

### T11 — Malicious or failing release callback · **Medium (payee opt-in)**
- The payer cannot opt a payee into callbacks without its authorization:
  when `notify_payee` is true, both single-releaser and quorum creation call
  `payee.require_auth()`. The payee contract can still consume transaction
  budget, fail, or attempt to re-enter `release`, `refund`, or `create_escrow`.
- Callback errors fail `release` atomically (`CallbackFailed`); token movement
  and the `Released` state do not persist. The releaser can still refund, and
  anyone can refund after `refund_after`. Refund never invokes the payee.
- Soroban rejects re-entry while the escrow is on the call stack. Tests in
  `tests/release_callback.rs` cover release/refund/create attempts; the same
  settlement helper handles single and quorum releases. The callback is one
  synchronous call with fixed arguments and no retries or loops. See ADR 0005.

### T11 — `refund_to` unable to receive, or set wrongly · **Low–Medium (funder error), document it**
- **Immutable by design (I1):** the funder signs `refund_to` at creation
  and there is no setter and no payout-time fallback. A typo'd or
  uncontrolled address means refunds go there.
- **Cannot receive:** if the token's `transfer` to `refund_to` fails (for
  a Stellar asset, typically a missing trustline), every refund path
  fails and the escrow stays `Funded`; `release` is unaffected, so the
  funds are recoverable only by releasing to the payee. This is the same
  property `payee` has today. Funders should check the destination can
  hold the token before creating the escrow. The default (`payer`) is the
  funder, who can.
- **Contract itself:** rejected at creation (`InvalidRefundTo`), since
  funds sent to the contract address could never be moved out again.
  This is the `refund_to` half of the open "reject contract-self"
  mitigation under T2; `payee` and `releaser` are still not checked.
- **Residual risk:** none that I1 doesn't already cover — no one but the
  funder chooses the address, and only at creation.

## 4. SDK-specific notes (`sdk/src/index.ts`)

- **Defaults are testnet only** (hard rule 4). A caller can still pass a
  mainnet `rpcUrl`/`networkPassphrase` explicitly. That's intentional,
  so gate it in the consumer, not here.
- **`contractId` is caller-supplied and unchecked.** A misconfigured or
  tampered `contractId` points the SDK at an arbitrary contract with the
  same function names. Then `createEscrow` would send the payer's funds
  there. Consumers should pin `contractId` in config and compare it to
  the WASM hash in `docs/testnet-deployments.md`.
- **Keys are held in process memory as `Keypair`s.** The SDK never logs
  or persists them. Protecting them is the consumer's job (see T1).

## 5. Consumer integration notes (custodial pattern)

These are about how the contract gets used, not about the contract. They
belong to the consumer, but they shape the real-world risk.

- **One payer key + one releaser key for everything** (see T1).
  Compromising the consumer's environment secrets compromises every
  open escrow, and the consumer's HTTP-layer authorization becomes the
  real control on release/refund.
- **Check-then-act on funding.** If the consumer checks "not yet
  funded" in its database, calls `create_escrow`, then writes the
  result, two concurrent requests can create two on-chain escrows. So
  can a crash between the chain call and the database write. The extra
  escrow is still controlled by the consumer's releaser, so it's
  recoverable by refund, not lost. But it's untracked unless someone
  reconciles on-chain escrows with the database. Recommended: a
  row-level lock or status transition (`created → funding`) before the
  chain call, plus a periodic reconcile job.
- **Payee address provenance.** The `payee` is whatever address the
  consumer recorded for the recipient at funding time. Whoever can
  change that record before funding controls where a release goes.

## 6. Pre-mainnet checklist (proposed)

Not all of these need contract changes. Items marked ⚙ do, and each
needs tests in `contracts/escrow/tests/` in the same PR (hard rule 2).

- [x] ⚙ Checks-effects-interactions ordering in `release`/`refund` (T4)
      — done 2026-10-20 (ADR 0006): all settlement paths write status first
      via `settle()`, with a rollback test
- [ ] ⚙ Reject contract-self as `payee`/`releaser` (T2)
- [x] ⚙ Decide on a timeout refund path, or record why not in an ADR (T2)
      — **both**: `docs/adr/0004` records the decision and the
      alternatives, and issue #11 implemented it (`refund_after`,
      `get_escrow`, tests in `contracts/escrow/tests/timeout_refund.rs`,
      live on testnet). The remaining T2 mitigations (contract-self as
      payee/releaser, key backup/multisig) are still open above.
- [ ] ⚙ Balance-delta check on `create_escrow` (T5)
- [x] ⚙ Optional `refund_to` distinct from the funder, I1 wording
      updated — issue #28, `docs/adr/0006`, `tests/sponsored_refund.rs`.
      Also rejects the contract itself as `refund_to` (T11). Not yet
      deployed to testnet.
- [ ] ⚙ TTL extension for escrow entries and instance (T6)
- [ ] ⚙ Emit create/release/refund events (T7)
- [x] Tests with a malicious mock token: lying transfer, short
      delivery, re-entry attempt (T4, T5) — issue #12,
      `tests/malicious_token.rs`
- [ ] Releaser held as multisig or in a KMS, not a plain env var (T1, T2)
- [ ] Consumer funding flow made idempotent + reconcile job (§5)
- [ ] **Independent review of this document and the contract**, linked
      from issue #6

## 7. For reviewers

Most useful to the project, in order:
1. Break any invariant in §1.
2. Answer the "Reviewer, please verify" items in T3, T4 and T6.
3. Disagree with a severity rating, or name a threat that's missing.

Leave findings as comments on the PR that adds this file, or on issue #6.
A review only counts toward E4 if the reviewer is not the implementer
(see issue #6).


## T6 archive/restore regression coverage

Escrow identifiers are monotonic and are never derived from the number of live entries. The restoration test plan therefore verifies that restoring an archived `NextId` cannot overwrite a live escrow; a new create must receive an identifier greater than every previously issued identifier. Settlement tests also re-check the `Funded` guard after restoration before release or refund.
