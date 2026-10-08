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

*Updated 2026-10-08 for issue #11 (Phase E4): the timeout refund path
from T2's candidate list was decided in `docs/adr/0004` and implemented
(`refund_after` + `get_escrow`), so T2, T8 and the §6 checklist below now
reflect that. The scope commit above predates the change; everything else
in this document still describes the same design.*

---

## 1. What the contract is supposed to guarantee

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Funds only leave an escrow to that escrow's `payee` (on release) or `payer` (on refund). No other destination exists. | Destinations are read from storage, never from call arguments (`lib.rs:165`, `lib.rs:203`). The `refund_after` timeout path (issue #11, ADR 0004) adds a new *caller*, not a new destination. |
| I2 | Only the escrow's `releaser` can move funds out — or, once `refund_after` has passed, anyone at all, and then still only back to `payer`. | `caller.require_auth()` + `caller == data.releaser`, relaxed solely by the deadline check (`lib.rs:149`, `lib.rs:183`, `lib.rs:191`). |
| I3 | Each escrow pays out at most once. | `status == Funded` check before transfer, status written after — shared by release and both refund paths. |
| I4 | An escrow only exists if `amount` was actually transferred in. | `payer.require_auth()` + token `transfer` before the escrow is stored (`lib.rs:96-112`). |
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
| `payer` | Create escrows by funding them; chooses `payee`, `token`, `releaser` | Nothing after creation. Has no on-chain power to cancel. |
| `payee` | Receive funds | Nothing. Has **no on-chain power at all**, including no way to object to a refund. |
| `releaser` | `release` or `refund` its escrows, once | Choosing the correct outcome. This is the main trust assumption. |
| `token` contract | Executes transfers | Behaving like a standard SEP-41 token (see T5). |
| Anyone | Call `create_escrow` with their own funds, call `get_status`/`get_escrow`, and — on an escrow whose `refund_after` has passed — call `refund`, which can only send funds back to that escrow's `payer` | Nothing. |

There is **no admin, no upgrade function, and no pause.** The deployed
WASM is immutable. Nobody, including the deployer, can change an
escrow's data or move funds outside `release`/`refund`.

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
- **Mitigations to consider:**
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
  first. Depending on protocol version and client tooling, this either
  happens automatically during simulation or needs an explicit restore
  operation. Either way, someone has to pay for it.
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

- [ ] ⚙ Checks-effects-interactions ordering in `release`/`refund` (T4)
- [ ] ⚙ Reject contract-self as `payee`/`releaser` (T2)
- [x] ⚙ Decide on a timeout refund path, or record why not in an ADR (T2)
      — **both**: `docs/adr/0004` records the decision and the
      alternatives, and issue #11 implemented it (`refund_after`,
      `get_escrow`, tests in `contracts/escrow/tests/timeout_refund.rs`,
      live on testnet). The remaining T2 mitigations (contract-self as
      payee/releaser, key backup/multisig) are still open above.
- [ ] ⚙ Balance-delta check on `create_escrow` (T5)
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
