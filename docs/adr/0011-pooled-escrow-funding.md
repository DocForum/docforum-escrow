# ADR 0011 — Pooled escrows funded by multiple payers with pull-based refunds

- **Status:** Accepted (2026-10-22)
- **Phase:** E5 — Contract features (issue #113)
- **Deciders:** contract maintainers
- **Related:** [ADR 0002](0002-per-escrow-releaser-set-at-creation.md)
  (per-escrow releaser), [ADR 0004](0004-timeout-refund-path.md) (timeout
  refund), [ADR 0006](0006-openzeppelin-stellar-library-evaluation.md)
  (checks-effects-interactions), [ADR 0009](0009-sponsored-funding-refund-to.md)
  (`refund_to`), `docs/threat-model.md` I1, I4, T3, T5.

## Context

Group purchases, shared costs and crowdfunded work need several payers to
fund one agreement. Today one escrow has exactly one `payer`: integrators
must either collect funds into their own account first (custody, which
this contract exists to avoid) or create one escrow per funder, which can
then be settled inconsistently (one released, one refunded) even though
the parties meant a single agreement.

Constraints carried in from the existing design:

- **ADR 0001/0002:** no contract-level admin, no new global role.
- **Invariant I1 (existing wording):** funds only ever leave to the
  stored `payee` (release) or the stored `refund_to` (refund). A pooled
  escrow must not weaken this — it *generalizes* it: refunds go only to
  recorded contributors, in their recorded amounts.
- **Invariant I4:** an escrow only exists, or grows, if the declared
  funds were actually transferred in — every contribution must pass the
  same balance-delta verification as `create_escrow`/`top_up`
  (`transfer_in_exact`, `BalanceMismatch`).
- **Hard rule 2:** every contract change ships with tests.
- Resource limits: no entry point may iterate an unbounded list inside
  one transaction (issue "edge cases": unbounded contributor lists make
  refunds exceed resource limits).

## Decision

**Option A — open contributions until a fixed funding target — is
chosen**, with these concrete rules:

1. **Explicit funding target, required and immutable.** A new
   `create_pooled_escrow(creator, payee, token, funding_target,
   condition_ref, releaser, funding_deadline)` creates an escrow whose
   stored `EscrowData.amount` starts at 0 and grows with contributions.
   `funding_target > 0` is enforced at creation (`InvalidAmount`).
2. **Open contribution.** `contribute(escrow_id, payer, amount)` is
   permissionless: any address may fund the escrow from its own tokens,
   while `now < funding_deadline` and `funded + amount <= target`.
   The contributor authorizes the pull (`payer.require_auth()`), the
   contract verifies the received amount with the existing balance-delta
   check, and only then records the contribution, accumulating per payer
   (repeated contributions sum; different payers stay independent).
   Rejected: zero/negative amounts (`InvalidAmount`), after the deadline
   (`FundingDeadlinePassed`), and anything that would push the total over
   the target (`FundingTargetReached` — overfunding and post-target
   contributions are rejected, not accepted-and-refunded).
3. **Release pays the total, but only on full funding.** `release`
   (and `release_with_approvals`) on a pooled escrow additionally
   requires `funded == funding_target` (`FundingIncomplete` otherwise),
   so partial funding can never be released. A successfully funded pooled
   escrow releases its whole `data.amount` — the pooled total — to the
   stored payee through the unchanged `settle()` path. Once the target
   has been reached, the funding deadline is irrelevant to release: the
   funding succeeded and the releaser can act whenever.
4. **Deadline miss ⇒ pull-based refunds, forever recoverable.** When the
   deadline passes with `funded < target`, the funding window is closed
   for good (contributions are frozen; the total can only go down), and
   `claim_refund(escrow_id, contributor)` opens to every recorded
   contributor, at any later time. Each claim pays exactly the recorded
   amount to the contributor, requires that contributor's own
   authorization, can happen exactly once (`AlreadyRefunded` on the
   second attempt), and is O(1) work — no entry point ever loops over
   contributors. Refund order therefore cannot change entitlements.
   A contributor with no recorded contribution gets `NoContribution`.
5. **No pre-deadline withdrawal.** Contributors cannot withdraw before
   the deadline. Until the deadline decides the outcome, the payee and
   releaser can rely on `funded` never decreasing; a withdraw-anytime
   design would also let a contributor yank funds right before a release
   lands. The funding window is a commitment; the deadline is the only
   early exit, and it exits into per-contributor claims.
6. **Push refunds are disabled on pooled escrows.** `refund`,
   `refund_with_approvals`, `cancel` and `top_up` reject pooled escrows
   with the new `NotSupportedForPooled` error. `refund`/`cancel` would
   send the whole pooled total to `refund_to` (one address), violating
   "refund each contributor exactly what they recorded"; `top_up` would
   grow `data.amount` without a contribution record, breaking the
   accounting that claims rely on. A pooled escrow has no `refund_after`
   (there is no push timeout path to open), and `rotate_releaser` stays
   available — it only changes who may release, not where funds go.
7. **Contributor count is deliberately unbounded.** See "Resource
   limits" below.
8. **Single-payer escrows are untouched.** Pooled behavior lives behind
   the new creation entry point and two new storage keys; `EscrowData`,
   every existing entry point, and every existing error keep their exact
   meaning. A pooled escrow is recognizable by its `DataKey::Pooled`
   record, and `get_pooled` / `get_contribution` expose the funding
   state read-only (`get_status` keeps returning `Funded` for an
   underfunded pooled escrow — its four-value vocabulary describes
   *settlement*, and a failed funding round never settles; `get_pooled`
   is where integrators read "target missed").

### Option B — fixed contributor list, evaluated and rejected

| Criterion | Fixed contributor list (Option B) | Open contributions to a target (Option A, chosen) |
|---|---|---|
| Contributor list management | Someone must set the list at creation and keep it authoritative. Under ADR 0002 there is no admin, so the list would be immutable creator-chosen data: a dead or hostile member's slot is irrecoverable, and a member who never contributes may make the target unreachable. | No list exists to manage or grieve; anyone can supply the target. |
| Authorization | Each listed address must still authorize its own transfer, exactly like Option A — the list adds no cryptographic strength, only a membership check. | Contribution auth is the transfer itself: you can only contribute your own funds. |
| Contribution limits | A per-contributor cap is natural here, but caps are extra state to validate and can be reached exactly like Option A's target, so they buy nothing over one aggregate target. | One aggregate target subsumes per-contributor limits for the contract; integrators who need per-payer caps can enforce them off-chain before accepting a contribution's deal. |
| Partial participation | A missing listed member silently shrinks what can ever be funded; the failure mode is the same missed-target case as Option A, minus the recovery of replacing the member. | Same failure mode (missed target), but any address can fill the gap on-chain. |
| Missed funding deadlines | Same handling needed as Option A — a list does not solve the deadline problem. | Deadline + pull refunds (rules 4 and 5). |
| Refund complexity | Identical: refunds must still go per contributor in recorded amounts; the list does not reduce a single storage read or loop. | Per-contributor records with O(1) pull claims. |
| Resource limits | A list *bounds* the count, but at the price of a cheap griefing vector (see below). | Unbounded count with per-claim O(1) work and no iteration anywhere. |

A closed set is still achievable with Option A *without* contract
support: an integrator that only wants known payers simply declines to
promote a deal unless the expected addresses have contributed the target
— settlement authority (the releaser) already decides that off-chain,
exactly as `condition_ref` stays opaque (ADR 0001).

### Resource limits

Soroban transactions are bounded by CPU/memory budget, so the danger is
any entry point that loops over all contributors (push refunds would).
This design contains **no contributor iteration anywhere**: `contribute`
and `claim_refund` each touch a constant number of storage keys, and the
aggregate total is maintained in `EscrowData.amount` on every write.
Pull claims are therefore bounded work regardless of contributor count,
which is the issue's preferred answer ("bound them **or** use pull-based
refunds per payer").

A hard contributor cap was considered and rejected: with pull refunds,
a cap buys no safety and *creates* an attack — an attacker fills the cap
with dust contributions from throwaway addresses (cost: transaction
fees only), after which every legitimate contribution is rejected,
funding fails, and the attacker claims its dust back. With no cap,
sabotaging funding requires actually locking the target amount. The
resource cost of many small contributor records stays with the
contributor who writes them (rent is paid by the writer), and
`get_escrow`/`get_pooled` never enumerate contributions.

### Storage shape

`EscrowData` is **unchanged**. Two keys are appended to the internal
`DataKey` enum (Soroban encodes enum variants by name, so existing
entries are untouched):

```rust
enum DataKey {
    // ... unchanged ...
    Pooled(u64),                // PooledData: immutable funding config
    Contribution(u64, Address), // Contribution: per-payer record
}

struct PooledData {
    pub funding_target: i128, // immutable; > 0
    pub funding_deadline: u64, // immutable unix seconds
}

struct Contribution {
    pub amount: i128,   // cumulative accepted contributions, > 0
    pub refunded: bool, // claim completion marker
}
```

The aggregate funded amount is `EscrowData.amount` — one source of
truth shared with `settle()` — and the invariant
`data.amount == Σ unclaimed contributions` is maintained by
`contribute` (++) and `claim_refund` (--) with checked arithmetic.

### Lifecycle rules (normative)

| State | Contribute | Release | Claim refund |
|---|---|---|---|
| `funded < target`, `now < deadline` | accepted (until target) | `FundingIncomplete` | `RefundNotOpen` |
| `funded == target` (any time) | `FundingTargetReached` | allowed (existing releaser/threshold rules) | `FundingTargetReached` (success — release, don't refund) |
| `funded < target`, `now >= deadline` | `FundingDeadlinePassed` | `FundingIncomplete` | open to each contributor, once each, order-independent |
| after `Released` | `NotFunded` | `NotFunded` | `NotFunded` (released funds can never be claimed) |

A failed funding round leaves `get_status` at `Funded` (no settlement
happened); integrators read `get_pooled` and the ledger timestamp to
classify a round as open, successful, or failed. The escrow is never
permanently locked: the failed round's funds are always recoverable by
their contributors, and a successful round has exactly the same
release-or-stuck properties as a single-payer escrow without a timeout
(recommendation: releasers should be backed up; see threat model T2).

### Errors (append-only, codes 26–34)

| Code | Error | Meaning |
|---|---|---|
| 26 | `NotPooled` | `contribute`/`claim_refund`/`get_contribution` on a non-pooled escrow; `get_pooled` on a non-pooled or unknown id |
| 27 | `FundingDeadlinePassed` | contribution after the funding deadline |
| 28 | `FundingTargetReached` | contribution would push the total over the target (or the target is already met); claim on a fully funded pooled escrow |
| 29 | `FundingIncomplete` | release attempt on a pooled escrow below its target |
| 30 | `RefundNotOpen` | claim before the deadline passed on an underfunded round |
| 31 | `AlreadyRefunded` | second claim by the same contributor |
| 32 | `NoContribution` | claim by an address with no recorded contribution |
| 33 | `NotSupportedForPooled` | `refund`, `refund_with_approvals`, `cancel` or `top_up` on a pooled escrow |
| 34 | `InvalidFundingDeadline` | funding deadline not strictly in the future at creation |

## Consequences

- **Additive contract surface.** No existing signature, error meaning or
  stored shape changes; single-payer suites run unchanged. New entry
  points: `create_pooled_escrow`, `contribute`, `claim_refund`,
  `get_pooled`, `get_contribution`. The SDK adds matching wrappers and
  bumps `@docforum/escrow-sdk` **0.7.0 → 0.8.0** (minor, additive; hard
  rule 3). The generated bindings must be regenerated (CI issue #121
  check).
- **Invariant I1 generalizes** (threat model, same PR): release pays the
  stored `payee` the pooled total; a refund is either a push to the
  stored `refund_to` (single-payer escrows) or a per-contributor pull of
  that contributor's exact recorded amount (pooled escrows). No other
  destination exists in either mode. I3 extends to "a contribution is
  refunded at most once" via the `refunded` flag; I4 extends to every
  contribution via `transfer_in_exact`.
- **Deployment required.** The live testnet deployment predates this
  change; testnet-only rule (hard rule 4) unchanged.
- **A failed round keeps `Funded` status.** Accepted trade-off: the
  four-value status vocabulary stays settlement-oriented and the SDK's
  `EscrowStatus` union stays source-compatible; `get_pooled` +
  ledger time are the funding-state API. Consumers that poll
  `get_status` must additionally read `get_pooled` for pooled escrows.
- **A fully funded pooled escrow with a lost releaser key is locked**
  exactly like a single-payer escrow created without `refund_after`
  (threat model T2). Pooled escrows deliberately have no push timeout,
  because routing a pooled timeout refund to one `refund_to` address
  would violate contributor accounting; contributors can only ever be
  refunded from a *failed* round.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Fixed contributor list at creation (Option B) | See the table above: no added security, dead slots are irrecoverable, refunds no simpler. |
| Push-based refunds (iterate contributors on timeout) | Unbounded loop: as contributors grow, refunds can exceed the transaction budget and lock everyone's funds — the exact failure the issue forbids. |
| Hard cap on contributor count | Enables cheap dust-griefing of the funding window (see "Resource limits"); unnecessary with O(1) pull claims. |
| Accept overfunding and refund the excess | Requires either a push loop or per-contributor excess accounting; rejecting the contribution is strictly simpler and makes `funded` monotone and exact. |
| Pre-deadline contributor withdrawal | Opens a race against release/payee expectations for no benefit; the deadline is the single early exit. |
| New `EscrowStatus` variants for funding rounds | Breaking read shape for every integrator and the SDK union; `get_pooled` exposes the same information without touching settlement vocabulary. |
| Model pooled escrows in the SDK only (like milestones) | Milestones are N independent single-payer escrows; a pooled escrow is one agreement with per-payer on-chain accounting, which the contract must enforce to keep refunds exact. |

## Tests

`contracts/escrow/tests/pooled.rs` covers: partial funding (aggregate
recorded, not releasable), target reached and release of the total,
repeated contributions accumulating per payer, independent records for
multiple payers, refunds to many payers with exact token balances, the
same entitlements under different refund orders, double-claim rejection,
claiming another contributor's funds, the failed-deadline recovery path
(contribute/claim/release boundaries), invalid contributions (zero,
negative, overflow-sized, late, overfunding at the exact boundary),
creation validation (non-positive target, past deadline, allowlist,
oversized `condition_ref`), push-path and `top_up` rejection on pooled
escrows, `NotPooled` on ordinary escrows, and an unbounded contributor
count with independent O(1) claims. `contracts/escrow/tests/malicious_token.rs`
gains lying-transfer and short-delivery contribution cases proving a
failed contribution updates no record (`BalanceMismatch`, I4). Existing
single-payer suites run unchanged (compatibility, scenario M).

## References

- Issue #113.
- Threat model I1, I2, I3, I4, T3, T4, T5, T8, T13 (`docs/threat-model.md`).
- Soroban storage: enum `DataKey` variants serialize by name, so the two
  appended variants do not disturb existing entries.
