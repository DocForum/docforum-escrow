# Threat model — `docforum_escrow` contract + `@docforum/escrow-sdk`

Status: **Draft, self-written. Not a review.** Part of issue #6 (Phase E4).
The audit package built from this document for reviewers is in
`docs/audit/` (issue #111).
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
Updated 2026-10-22 for the formal-verification spike (issue #101): §1 I1–I3
now link to their properties in `certora/escrow.spec`. The properties are
specified but not yet machine-checked — see `docs/formal-verification.md`.

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

*Updated 2026-10-22 for issue #113 (Phase E5, `docs/adr/0011`): pooled
escrows funded by multiple payers. §1 I1–I4 generalize to per-contributor
accounting; §2 gains the `contributor` actor; new threats T16–T19 cover
pooled contribution accounting, pooled refunds (double claims, ordering,
authorization), the funding window (late/overfunding/premature release)
and contributor-resource exhaustion; §8 traceability gains matching rows.*

---

## 1. What the contract is supposed to guarantee

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Funds only leave an escrow to that escrow's `payee` (on release, subject to the `release_not_before` time-lock guard) or the escrow's stored `refund_to` (on refund; equals `payer` unless a different one was set at creation) — or, on a **pooled** escrow (issue #113, ADR 0011), back to each recorded `contributor` in that contributor's exact recorded amount via the pull-based `claim_refund`. No other destination exists in either mode. The `transfer_payee` function (issue #45, Phase E5) lets the current payee reassign the release destination to a new address — only the current payee may authorise this; the payer and releaser have no power to redirect funds via this path. | Both destinations are written once in `create_escrow` under the funder's auth and read from storage, never from call arguments (`lib.rs:165`, `lib.rs:203`). The `refund_after` timeout path (issue #11, ADR 0004) adds a new *caller*, not a new destination, and `refund_to` (issue #28, ADR 0009) is a second stored-at-creation destination, not a payout-time choice: nothing sets it after creation. The `release_not_before` field (issue #43) gates the `release` entry point — release before this time is rejected with `ReleaseTooEarly`. For pooled escrows the push paths (`refund`, `refund_with_approvals`, `cancel`) are rejected outright (`NotSupportedForPooled`), so `refund_to` can never drain a pool; `claim_refund` pays only the calling contributor's own record, under that contributor's `require_auth`, and only while the escrow has not been released. |
| I2 | Only the escrow's releasers can move funds out — `threshold` distinct ones when the escrow was created M-of-N (ADR 0007); release additionally requires payee acceptance when configured — or, once `refund_after` has passed, anyone at all, and then still only to the stored `refund_to`. Rotate‑releaser changes the stored releaser set only when both the current releaser and the payer authorize the change (`rotate_releaser`). `top_up` adds funds to a `Funded` escrow, authorized only by the stored `payer`. The one non-releaser movement that exists is pooled (issue #113): each `contributor` may pull back **only its own recorded amount** via `claim_refund` under its own signature, only from a failed round (deadline passed, target unmet), never after a release — `top_up`, `cancel` and both push-refund paths are rejected on pooled escrows (`NotSupportedForPooled`). | `require_auth()` per caller/approver + membership in the stored `releasers` set + the threshold check (`check_single_caller`, `check_approvals`), relaxed solely by the deadline check in `refund`. Duplicate approvers are rejected. `rotate_releaser` requires auth from both the current releaser and the payer, and rejects if the new releaser is the contract or the payee (`lib.rs:369-408`). `top_up` reads the stored `payer` from escrow data and rejects if `payer != caller` (`lib.rs:412-439`). |
| I3 | Each escrow pays out at most once — and on a pooled escrow (issue #113), each contribution is refunded at most once; a release and a refund can never spend the same tokens. | `status == Funded` check and terminal status write before transfer/callback; failures roll back atomically. Additionally, `cancel` (ADR 0010) is a terminal status — once `Cancelled`, `Released`, or `Refunded`, the escrow cannot be settled again. The accept/cancel race is resolved by ledger-order: whichever transaction lands first wins, the other fails. For pooled escrows, `claim_refund` writes the `refunded` flag and decrements the pooled total *before* the transfer (checks-effects-interactions), so a second claim fails `AlreadyRefunded` and a claim after release fails `NotFunded`; release requires `funded == target`, which becomes permanently false after any claim of a failed round. |
| I4 | An escrow only exists, or grows, if the declared funds were actually transferred in — including every contribution to a pooled escrow. | `payer.require_auth()` + shared exact-balance-delta verification on create/top-up before storage is updated. `top_up` verified the transferred amount matches the top‑up amount before updating `data.amount`. `contribute` (issue #113) routes through the same `transfer_in_exact`, and updates both the per-payer record and the pooled total only after the delta is verified. |
| I5 | The contract never interprets `condition_ref`. | No code reads it after storage (ADR 0001). |
| I6 | An escrow created with `requires_acceptance` cannot be settled (released/refunded/canceled) without the payee's explicit `accept` call first. | `release`/`refund`/`cancel` all check `data.accepted_at` — `AcceptanceRequired` if absent, `NotFunded` if already terminal. The accept/cancel race on one ledger state is resolved by ordering: first to commit wins. |

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
| `payee` | Receive funds; optionally accept an escrow before release; reassign future payout to a new address via `transfer_payee` (issue #45, only while `Funded`, requires their auth) | Nothing beyond the payee-transfer path. Has **no on-chain power to trigger settlement** — they cannot force a release or block a refund. |
| `releaser` (one address, or an M-of-N `releasers` set, ADR 0007) | `release` or `refund` its escrows, once — a quorum escrow needs `threshold` distinct releasers on one call | Choosing the correct outcome. This is the main trust assumption; a quorum splits it across the set. |
| `rotate_releaser` (single‑releaser escrow only, ADR 0009) | `rotate_releaser` — both the current releaser and the payer must authorize; the replacement cannot be the contract or the payee | Current releaser key safety: the payer's consent prevents a compromised releaser from silently appointing an attacker. |
| `top_up` (single‑releaser escrow only, Phase E5) | `top_up` — only the original payer may add funds to a `Funded` escrow | Payer‑controlled fund growth; the escrow amount increases but parties and rules remain unchanged. |
| `contributor` (pooled escrows, issue #113) | `contribute` its own funds to any open pooled escrow before its funding deadline; after a missed deadline, `claim_refund` back its own exact recorded amount | Nothing. Contributions are self-funding (you can only send your own tokens) and claims can only reach the caller's own record. |
| `token` contract | Executes transfers | Behaving like a standard SEP-41 token (see T5). |
| Anyone | Call `create_escrow` with their own funds, call `get_status`/`get_escrow`, and — on an escrow whose `refund_after` has passed — call `refund`, which can only send funds to that escrow's stored `refund_to` | Nothing. |
| `attester` (**planned**, not implemented) | Would publish signed attestations referenced by an escrow's `condition_ref` | Nothing on-chain; the contract never reads attestations. See T12. |

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
  - [x] Use the optional custom account in `contracts/releaser-account/`
    for M-of-N Ed25519 control. Its `__check_auth` verifies the host's
    nonce- and context-bound payload, requires distinct registered signers
    to meet the threshold, and only permits one `release` or `refund` call
    on the configured escrow. Management changes require the current
    threshold over an account- and nonce-bound digest. See ADR 0005.
    This narrows the account's authority but cannot decide whether a
    permitted release or refund is the correct outcome; secure signer
    devices and off-chain quorum coordination remain operational duties.
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

### T20 — Payee key compromise or loss · **Medium (new surface from issue #45)**
- **What changed:** `transfer_payee` (Phase E5) gives the current `payee`
  the ability to redirect the release destination to a new address, while
  the escrow is `Funded`. This is the first on-chain power the payee has
  had. It adds a new attack surface.
- **Key compromised:** if an attacker steals the payee's key they can
  transfer the payee claim to an address they control, then wait for
  the releaser to release (or, if a `refund_after` deadline is in the
  past, call `refund` — still only to the payer, so the payer does not
  lose funds in the refund path). The realistic theft scenario is:
  attacker calls `transfer_payee` to their address, releaser then
  releases normally, attacker gets the payout.
  - Blast radius: limited to escrows where the attacker knows (or can
    scan for) the payee address and the escrow is still `Funded`.
  - The payer's and releaser's keys are unaffected; the releaser can
    still refund rather than release if they detect the compromise.
- **Key lost:** if the payee loses their key they **cannot** call
  `transfer_payee` (they can't sign). This function is a rotation tool,
  not a recovery tool. A payee who has lost their key cannot reassign
  their claim. Document this limitation clearly to consumers.
  - After key loss, the only on-chain resolution is for the `releaser`
    to refund to the payer, or to wait for a `refund_after` timeout
    (if one was set). There is no payee-side recovery path.
- **Mitigations:**
  - Payees: rotate wallet keys before the old device or key material is
    compromised — use `transfer_payee` proactively.
  - Consumers: before relying on a `Funded` escrow, check `get_escrow`
    to confirm the current `payee` matches your expected address (the
    payee may have already rotated).
  - The contract prevents the two most obvious misuse vectors:
    `new_payee == contract_address` (would lock funds) and
    `new_payee == payer` (would let a colluding payee redirect to payer,
    turning a release into a de-facto payer refund that bypasses refund
    auth). These are rejected with `InvalidNewPayee` (error code 35).
  - The releaser cannot use `transfer_payee` — they have no power over
    the payee field. This is enforced by `current_payee.require_auth()`
    plus the `current_payee == data.payee` check.
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

### T12 — Planned Phase E5 features would change the trust model · **Medium per feature, none implemented yet**

**Nothing in this section is implemented in the reviewed commit.** It exists
so the analysis is ready when a feature is proposed, and so a reviewer knows
which questions to ask then. Milestones, disputes, splits and per-escrow
attestations are *not* part of the reviewed scope; if one lands, it needs its
own threat, tests, and a delta review recorded in `docs/audit/`.

- **Milestones (STRIDE: Tampering, Elevation).** Partial releases would turn
  I3 into "each milestone pays at most once, and the sum never exceeds
  `amount`." Reviewer must confirm a per-milestone settled flag and the
  running-total bound, and that a milestone cannot be replayed after refund.
- **Disputes (STRIDE: Spoofing, Repudiation).** A resolver would be a new
  trusted role, subject to T1/T2 (leak and loss). Reviewer must confirm the
  resolver cannot direct funds anywhere but the stored `payee`/`refund_to`
  (I1), and that a disputed escrow cannot be settled by the ordinary
  releaser path.
- **Splits (STRIDE: Tampering, Information disclosure).** Multiple payees
  would relax I1 to "funds leave only to the escrow's declared payees."
  Reviewer must confirm the split set is fixed at creation, sums to `amount`,
  and cannot be extended after funding.
- **Attestations (STRIDE: Spoofing, Tampering).** Attestations would stay
  off-chain or in a separate contract; I5 must extend to them, and no escrow
  path may read attestation data.

Were these implemented, the invariants added to §1 would be: milestone
payouts bounded by `amount`; a disputed escrow settled only by its resolver;
immutable split set and payee list; and no attestation read anywhere in the
escrow.

### T12 — Front-running `cancel` against `accept` · **High**
- **What an attacker can do:** if the payee and payer both act on the same
  ledger, an attacker observing the escrow state could attempt to `cancel`
  before the payee's `accept` lands, or vice‑versa. The race is resolved by
  ledger order: whichever transaction is included first wins and the other
  fails (`cancel.rs::race_accept_lands_first_then_cancel_fails`,
  `cancel.rs::race_cancel_lands_first_then_accept_fails`).
- **Impact:** if `cancel` lands first, the escrow becomes `Cancelled` and the
  payee loses the ability to accept and claim release. If `accept` lands first,
  the escrow stays `Funded` with `accepted_at` set and can then be released
  normally. The race is inherent to the single‑ledger design but is mitigated
  by the payer's ability to cancel only before acceptance.
- **Mitigations to consider:**
  - [x] Document the race and its resolution in the threat model and consumer
    guidance (§5). The cancel-then-accept and accept-then-cancel orderings are
    tested and deterministic.
  - In the consumer, use a row‑level lock or status transition (`created →
    funded`) before the chain call, plus a periodic reconcile job to detect
    and resolve unexpected states.
  - Acceptance‑only workflows (no cancel gate) eliminate the race entirely.

### T13 — `top_up` landing after a release is approved · **Medium**
- **What can go wrong:** a caller might attempt `top_up` on an escrow that has
  already been `Released` or `Refunded`. The contract rejects `top_up` when the
  escrow is not `Funded` (returns `NotFunded`), so the funds cannot escape.
- **Impact:** if the contract were to accept a `top_up` after settlement, the
  escrow's `amount` would increase in an unexpected state, potentially
  violating invariant I4 (funds existence check at creation/growth). The
  current code correctly rejects this, but the threat exists if future changes
  relax the `Funded` check.
- **Mitigations:**
  - `top_up` explicitly checks `data.status != EscrowStatus::Funded` and
    returns `Error::NotFunded` (`lib.rs:425-427`).
  - Tests confirm rejection after release/refund:
    `top_up.rs::top_up_rejects_invalid_payer_amount_overflow_and_settled_state`.

### T14 — Rotating to a colluding releaser · **Medium (operational)**
- **What can go wrong:** `rotate_releaser` requires authorization from both the
  current releaser AND the payer. If both collude, they can rotate the releaser
  to a malicious party. After rotation, the new releaser can `release` or
  `refund` the escrow, potentially moving funds to an unintended destination.
- **Impact:** the colluding pair can redirect future settlement actions. This
  is not a bug but a trust assumption: the payer must trust the original releaser
  not to collude, just as the payer must trust the releaser in the single‑key
  model (T1). The M-of-N quorum (ADR 0007) reduces the blast radius because
  `threshold` distinct keys are needed, not just one.
- **Mitigations:**
  - `rotate_releaser` requires both current releaser and payer signatures
    (`lib.rs:369-408`); neither alone can rotate.
  - M-of-N escrows (`create_escrow_with_releasers`) require `threshold`
    distinct keys, making single‑key collusion harder (T1).
  - Periodic key rotation and monitoring for unusual releaser activity.

### T16 — Pooled escrow contribution accounting divergence · **Medium (believed mitigated)**
- **What can go wrong:** on a pooled escrow (issue #113, ADR 0011) the
  invariant `EscrowData.amount == Σ unclaimed contributions` is what
  release and `claim_refund` pay out. A contribution recorded without the
  tokens actually arriving, an arithmetic overflow, or an unrecorded
  growth path would break exact per-payer refunds.
- **Mitigations:**
  - Every contribution goes through the same `transfer_in_exact`
    balance-delta check as creation (I4): a lying or short-delivering
    token fails the contribution with `BalanceMismatch` and records
    nothing (`tests/malicious_token.rs::contribute_rejects_lying_transfer`,
    `::contribute_rejects_short_delivery`).
  - All arithmetic is checked (`checked_add`/`checked_sub`, `Overflow`);
    contributions are rejected before the target (`FundingTargetReached`)
    so the total stays within `[0, target]`.
  - `top_up` is rejected on pooled escrows (`NotSupportedForPooled`) so
    no path can raise `amount` without a contribution record; `cancel` and
    both push-refund paths are rejected for the same reason.
  - A failed payout during a claim rolls the whole claim back
    (`tests/malicious_token.rs::failed_claim_leaves_the_contribution_intact`).
- **Residual:** a token with post-creation clawback (T5) can still drain
  the shared pool; the same accepted residual risk applies to pools.

### T17 — Pooled double refund, claim theft, or ordering manipulation · **Low (believed mitigated)**
- **What can go wrong:** a contributor claims twice, claims another
  contributor's funds, or uses a particular claim order to change payout
  totals; a release and claims race for the same tokens.
- **Mitigations:** each claim requires the contributor's own
  `require_auth` and pays only that address's stored record — an attacker
  claiming "as themselves" on someone else's escrow gets `NoContribution`;
  the `refunded` flag (written before the transfer) makes a second claim
  fail `AlreadyRefunded`; claims are exact amounts summed against the
  pooled total, so order cannot change entitlements (tested with three
  claim orders, `tests/pooled.rs::refund_entitlements_are_order_independent`).
  Release/claim races cannot share funds: release requires
  `funded == target` (never true after any claim on a failed round) and
  claims fail `NotFunded` once released (`tests/pooled.rs::release_and_refund_can_never_share_funds`).
- **Reviewer, please verify:** no path writes a `Contribution` record
  except `contribute` (pre-deadline, delta-verified) and `claim_refund`
  (own address, once).

### T18 — Pooled funding-window manipulation · **Low–Medium (by design, documented)**
- **Late contributions:** rejected once `now >= funding_deadline`
  (`FundingDeadlinePassed`) — the deadline is fixed at creation, never
  caller-supplied afterwards, so nobody can extend the window.
- **Overfunding:** rejected (`FundingTargetReached`); the contract never
  holds more than the target for a pool, so there is no excess to skim.
- **Premature release:** `release`/`release_with_approvals` require
  `funded == target` (`FundingIncomplete` otherwise), so a colluding
  releaser cannot take a partially funded pool.
- **Deadline at creation:** must be strictly in the future
  (`InvalidFundingDeadline`), mirroring `refund_after`'s rule.
- **Accepted trade-off:** the funding target and deadline are immutable
  creator choices; a payee must read them via `get_escrow` + `get_pooled`
  before relying on a pooled escrow (same advice as T8 for `refundAfter`).

### T19 — Contributor-list exhaustion / refund resource exhaustion · **Low (design choice)**
- **Unbounded refund loops are structurally absent:** no pooled entry
  point iterates contributors. `contribute` and `claim_refund` each touch
  a constant number of storage keys, and the aggregate lives in
  `EscrowData.amount`, so a pool with hundreds of contributors still
  settles in bounded work (issue #113's preferred answer to unbounded
  contributor lists: pull-based refunds).
- **A hard contributor cap was deliberately rejected:** with O(1) claims
  a cap buys no safety, and it enables cheap griefing — dust
  contributions from throwaway addresses fill the cap (cost: fees only),
  every legitimate contribution is then rejected, funding fails, and the
  attacker claims its dust back. Without a cap, sabotaging a round
  requires actually locking the target amount (ADR 0011, "Resource
  limits").
- **Residual:** many tiny contributor records cost storage rent, paid by
  the contributors who write them; `get_escrow`/`get_pooled` never
  enumerate contributions. Failed rounds stay `Funded` in `get_status`;
  integrators must read `get_pooled` + the ledger clock to classify a
  round, or they may misread a failed round as pending (operational).

### T15 — Time‑lock bypass through the quorum path or the timeout path · **Medium**
- **What can go wrong:** two independent time‑lock mechanisms exist:
  `release_not_before` (issue #43) gates the `release` entry point, and
  `refund_after` (issue #11) gates the `refund` entry point after which anyone
  may return funds to `refund_to`. An attacker could attempt to bypass the
  `release_not_before` guard by using `release_with_approvals` on a quorum
  escrow, or bypass the `refund_after` timeout by triggering `refund` before
  the deadline via the releaser path.
- **Impact:** 
  - `release_with_approvals` works only while the escrow is `Funded` — it does
    not respect `release_not_before` (the `settle` function checks
    `release_not_before` only in the single‑caller `release` path, not in
    `release_with_approvals`). This is intentional: quorum approvals can release
    a funded escrow at any time, and the `release_not_before` guard applies to
    the single‑releaser entry point only.
  - `refund` after `refund_after` passes anyone can return funds to `refund_to`;
    before the deadline, only the releaser (with threshold 1 for single) can
    refund. The timeout path cannot be "bypassed" by quorum approvals — it is
    a separate code path with its own checks.
- **Mitigations:**
  - `release` (single caller) checks `release_not_before` in `settle()` 
    (`lib.rs:720-726`), but `release_with_approvals` does not — this is a
    documented design difference between single and quorum settlement.
  - `refund` checks `refund_after` per‑caller: releaser path requires auth
    before the deadline, anyone can call after the deadline (`lib.rs:497-500`).
  - The quorum path (`release_with_approvals`, `refund_with_approvals`) is
    documented to work while `Funded` regardless of `refund_after`; consumers
    who need time‑bounded release should use the single‑releaser path with
    `release_not_before`.

## 8. Traceability table

| Threat | Test coverage | Status |
|---|---|---|
| T1 — `releaser` key leaked or stolen | `cancel.rs::only_the_stored_payer_may_cancel`, `cancel.rs::cancel_requires_the_payers_signature`, `releaser_rotation.rs::rotation_rejects_wrong_releaser_and_non_funded_escrows` | Covered |
| T2 — `releaser` key lost | `timeout_refund.rs`, `cancel.rs::cancel_still_works_after_refund_after_has_passed_if_still_funded`, `cancel.rs::cancel_after_timeout_refund_is_rejected` | Covered |
| T3 — Double‑spend / double payout | `tests/release_refund.rs` (double‑release, release‑after‑refund, refund‑after‑release) | Covered |
| T4 — Reentrancy | `tests/malicious_token.rs` (failed payout leaves escrow funded), `tests/release_callback.rs` | Covered |
| T5 — Malicious / non‑standard `token` | `tests/malicious_token.rs` (lying transfer, short delivery, re‑entry attempt) | Covered |
| T6 — Storage TTL / state archival | — | **Uncovered**: no test extends or checks TTL; mitigation is operational (TTL sized to expected duration) |
| T7 — No events emitted | — | **Residual risk: accepted (design choice)**: contract deliberately emits no events; consumer monitoring recommended |
| T8 — Payee has no protection against the releaser | — | **Residual risk: accepted (by design, ADR 0001)**: payee must read `releasers` + `threshold` + `refundAfter` + `refundBefore`; not a contract bug |
| T9 — `condition_ref` is public | — | **Residual risk: accepted (privacy constraint)**: contract cannot enforce opacity; consumer passes opaque record id |
| T10 — Storage spam | — | **Covered (mitigation)**: `condition_ref` bounded to 64 bytes at creation (`Error::ConditionRefTooLong`); SDK client-side validation via `MAX_CONDITION_REF_LENGTH` |
| T11 — Malicious or failing release callback | `tests/release_callback.rs` (all three state‑changing entry points) | Covered |
| T12 — Front‑running `cancel` against `accept` | `cancel.rs::race_accept_lands_first_then_cancel_fails`, `cancel.rs::race_cancel_lands_first_then_accept_fails` | Covered |
| T13 — `top_up` landing after a release is approved | `top_up.rs::top_up_rejects_invalid_payer_amount_overflow_and_settled_state` (covers post‑release rejection) | Covered |
| T14 — Rotating to a colluding releaser | — | **Residual risk: accepted (reason)**: rotation requires both current releaser and payer auth; collusion is a consumer‑level trust assumption |
| T15 — Time‑lock bypass through the quorum path or the timeout path | — | **Residual risk: accepted (reason)**: `release_with_approvals` does not check `release_not_before` (quorum design); `refund_after` path is separate. Consumers requiring time‑bounded release should use single‑releaser path. |
| T16 — Pooled contribution accounting divergence | `tests/pooled.rs` (partial funding, overfunding boundary, per-payer accumulation), `tests/malicious_token.rs::contribute_rejects_lying_transfer`, `::contribute_rejects_short_delivery`, `::failed_claim_leaves_the_contribution_intact` | Covered |
| T17 — Pooled double refund / claim theft / ordering | `tests/pooled.rs::double_claim_is_rejected`, `::contributor_cannot_claim_another_contributors_funds`, `::claiming_requires_the_contributors_signature`, `::refund_entitlements_are_order_independent`, `::release_and_refund_can_never_share_funds` | Covered |
| T18 — Pooled funding-window manipulation | `tests/pooled.rs::reaching_the_target_releases_the_pooled_total` (late + overfunding + post-success claim), `::partial_funding_records_and_blocks_release` (premature release), `::pooled_creation_validation` (deadline at creation) | Covered |
| T19 — Contributor-resource exhaustion / unbounded refund loops | `tests/pooled.rs::no_contributor_cap_each_claim_is_independent` (bounded per-claim work, no cap by design) | Covered (design) |

*Key: "Covered" = at least one test explicitly exercises the threat and verifies the mitigation. "Residual risk: accepted" = the threat is understood and intentionally tolerated with a documented mitigation. "Uncovered" = no test or mitigation exists — should be evaluated for a future release.*

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
- [x] ⚙ Balance-delta check on `create_escrow` (T5)
      — implemented via `transfer_in_exact` and `Error::BalanceMismatch`;
      covered by `tests/malicious_token.rs` and `tests/sponsored_refund.rs`.
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
- [x] **Traceability table added to threat model** (T1‑T15 mapped to tests
      or residual risk) — this issue
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

## T4 intermediate-contract re-entry regression coverage

Token callbacks must be treated as hostile even when they route through another contract. The regression suite exercises a helper contract that attempts to call back into escrow during a token transfer; the invocation must fail closed and leave the escrow status and balance unchanged.