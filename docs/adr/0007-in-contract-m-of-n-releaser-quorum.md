# ADR 0007 — In-contract M-of-N releaser quorum

- **Status:** Accepted (2026-10-20)
- **Phase:** E5 — Contract features (issue #119)
- **Deciders:** contract maintainers
- **Related:** [ADR 0002](0002-per-escrow-releaser-set-at-creation.md)
  (per-escrow releaser), [ADR 0004](0004-timeout-refund-path.md) (timeout
  refund), [ADR 0006](0006-openzeppelin-stellar-library-evaluation.md) (why no
  OZ access-control module), `docs/threat-model.md` T1, T2, T3, T8.

## Context

Threat model T1 (releaser key leaked) and T2 (releaser key lost) are currently
mitigated *operationally*: make the releaser a Stellar multisig account so that
`require_auth` checks M-of-N signatures on that account. That works with no
contract change, and it remains the recommended path for anyone who can manage
accounts.

Some integrators cannot: they do not want to administer separate accounts,
fund them, or keep signer sets on-chain, and they do not want a single service
key holding settlement authority over every escrow. They asked for the releaser
set to live *on the escrow itself*: N addresses and a threshold, chosen at
creation. That is a different trade-off — more contract logic, simpler
operations — and issue #119 asks for it as an option, without changing
single-releaser escrows.

Constraints carried in from the existing design:

- **ADR 0001/0002:** no contract-level admin. The escrow itself may carry
  authority, but nothing global may.
- **T3 / invariant I3:** each escrow settles at most once.
- **T8:** the payee has no objection right; anything that makes settlement
  easier must not change *where* funds can go.
- **ADR 0004:** after `refund_after`, anyone may refund — always to the payer.
  This must keep working, including for quorum escrows (it is the recovery path
  when the releaser set is unusable).

## Decision

Add an **optional** in-contract M-of-N releaser set, settled by **one call
carrying all approvals**, with no stored approval state.

### Storage shape

`EscrowData` now stores:

```rust
pub struct EscrowData {
    // ... unchanged fields ...
    pub releasers: Vec<Address>,   // 1..=MAX_RELEASERS, no duplicates
    pub threshold: u32,            // 1..=releasers.len()
    pub refund_after: Option<u64>, // unchanged
}
```

- A plain `create_escrow(..., releaser, ...)` stores **one** entry and
  `threshold = 1`. Existing call sites, semantics and entry point are
  unchanged; the stored representation is the only thing that changed.
- `create_escrow_with_releasers(..., releasers, threshold, ...)` stores the set
  as given.

### New entry points

| Function | Who | When |
|---|---|---|
| `create_escrow(...)` | payer | unchanged, one releaser |
| `create_escrow_with_releasers(..., releasers, threshold, ...)` | payer | new, M-of-N |
| `release(escrow_id, caller)` | a releaser, threshold must be 1 | unchanged |
| `release_with_approvals(escrow_id, approvers)` | `approvers` = distinct releasers, at least `threshold` | new |
| `refund(escrow_id, caller)` | a releaser when threshold is 1, **or anyone** after `refund_after` | unchanged |
| `refund_with_approvals(escrow_id, approvers)` | `approvers` = distinct releasers, at least `threshold` | new |

`release`/`refund` deliberately do **not** gain an `approvers` argument:
changing their signatures would break every existing caller and the SDK for a
feature that only some escrows use. A quorum escrow's member that calls the
single-caller path fails with `ThresholdNotMet` (not `Unauthorized`), which
tells the integrator to use the approvals entry point rather than "you are not
allowed".

### How approvals are collected: one call, not accumulated

Two designs were considered:

1. **One call with M auths (chosen).** `release_with_approvals` takes an
   `approvers: Vec<Address>`, checks each address is a releaser, rejects
   duplicates, and calls `require_auth()` on each — so every listed address must
   have signed *that exact invocation*. The transaction is submitted once, by
   any of the approvers (who pays the fee); the other approvers sign only
   contract authorization entries. Soroban auth entries are bound to the
   invocation (contract, function, arguments) and expire, so nothing can be
   replayed against another escrow or another function.
2. **Accumulated approvals across calls** (`approve_release` per releaser, then
   settle once the counter reaches the threshold). Rejected because it adds
   per-escrow approval state that has to be bounded, cleared on settlement,
   protected against replay, and paid for on every call; a stuck partial
   approval set has no owner to clean it up; and it opens a griefing surface
   where one member can hold settlement hostage by approving early or not at
   all. With the one-call design, **there is no approval state to clear and
   nothing to replay** — the "cleared on settlement, can't be replayed" edge
   case in the issue is satisfied structurally rather than by bookkeeping.

Trade-off accepted: the M approvers must be available to sign the same
transaction (or hand auth entries to a relayer) rather than approving
asynchronously over time. Integrators who need asynchronous approval already
have the account-multisig path, which accumulates at the account layer.

### Validation rules

At creation (`create_escrow_with_releasers`), all errors are returned *before*
any auth prompt or transfer, so a malformed request costs the caller nothing:

- 1 to `MAX_RELEASERS = 10` addresses (`TooManyReleasers = 14` beyond that).
- `threshold >= 1` and `threshold <= releasers.len()` (`InvalidThreshold = 13`;
  an empty set also fails this, since any threshold is then > 0 = len).
- No duplicate addresses (`DuplicateReleaser = 17`).

At settlement:

- Fewer than `threshold` supplied (`ThresholdNotMet = 15`) — checked before
  authing anything.
- An approver that is not in the set (`Unauthorized = 3`).
- The same address twice (`DuplicateApprover = 16`) — **duplicates never count
  twice toward the threshold**; this is the check reviewers should try first.
- Escrow not `Funded` (`NotFunded = 4`) — covers replay after settlement.

`MAX_RELEASERS = 10`: covers 2-of-3, 3-of-5 and similar real multisig shapes;
keeps `get_escrow`'s payload, creation validation, and the O(n²) duplicate
scan bounded (n ≤ 10); and caps `EscrowData` growth (see costs below). Larger
sets can still use an account-level multisig as the single releaser.

### Settlement path and timeout interaction

- Both approval entry points use the same `settle()` helper as the single-caller
  ones: write the settled status, then transfer — checks-effects-interactions
  (ADR 0006, threat model T4). The destination is read from storage, never from
  arguments (invariant I1): `release*` → `payee`, `refund*` → `payer`.
- `release_with_approvals` is **not** gated by `refund_after`, exactly like
  `release` (ADR 0004): after the deadline the releaser set can still release,
  racing a timeout refund; the loser gets `NotFunded`.
- `refund` after `refund_after` needs no approvals and no membership — the
  recovery path is unchanged for quorum escrows. That is the answer to "what if
  several releasers are lost?": the deadline still returns funds to the payer.

### Errors

Append-only, following the existing scheme (1–8 and 12 are already used):

| Code | Error |
|---|---|
| 13 | `InvalidThreshold` |
| 14 | `TooManyReleasers` |
| 15 | `ThresholdNotMet` |
| 16 | `DuplicateApprover` |
| 17 | `DuplicateReleaser` |

## Consequences

- **Breaking storage/read change:** `get_escrow` now returns `releasers` and
  `threshold` instead of `releaser`. Single-releaser escrows keep working at the
  entry-point level, but integrators that read `EscrowData` must adapt; the SDK
  does so and bumps `@docforum/escrow-sdk` to **0.5.0** (hard rule 3).
- **Deployment required:** the live testnet deployment predates this change and
  the testnet-only rule (hard rule 4) is unchanged; `docs/testnet-deployments.md`
  gets a new entry only once a redeploy actually happens.
- **Threat model updates:** T1 gains a contract-level mitigation (no need for a
  single service key to hold settlement authority; a leaked single key is no
  longer sufficient at threshold > 1), and T2's loss case gains
  "threshold not met because one signer is unavailable" as an operational
  concern (the timeout refund remains the recovery path). T8's advice to check
  the releaser becomes "check `releasers` and `threshold`".
- **Cost** (measured like ADR 0006, `mock_all_auths`, same machine):

| Operation | CPU | Memory |
|---|---|---|
| `create_escrow_with_releasers` (3 releasers, 2-of-3) | 455,281 | 147,339 |
| `get_escrow` (3 releasers) | 76,933 | 42,725 |
| `release_with_approvals` (2 of 3) | 366,005 | 143,487 |
| `release` (single, for reference) | 331,825 | 130,914 |

  The approvals path costs ~34k more CPU than a single release, which is the
  two extra auth entries and the membership checks — not a storage difference.
  `create_escrow` for a single releaser is unchanged in shape and only ~1.6%
  more expensive than before (ADR 0006's table).
- **No new privileged role is introduced:** the releaser set is chosen by the
  payer at creation, is immutable afterwards, and there is no setter, no admin
  and no pause. Reviewers of ADR 0006's rule can treat `releasers` as escrow
  data, not as authority over the contract.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep account-level multisig only | Requires each integrator to manage accounts; doesn't help those who asked for this. Still supported and recommended. |
| Contract-level owner that can settle any escrow | Violates ADR 0002 and the "no hidden admin" rule outright. |
| Accumulated on-chain approvals | See above: extra state, clearing, replay window, griefing. |
| One call requiring **all** N releasers (`require_auth` for every stored address) | Simple, but not M-of-N: a single unavailable signer freezes the escrow until the timeout, which is strictly worse than the account-multisig it mirrors. |
| Change `release`/`refund` to take `approvers` | Breaks every existing caller and the SDK's stable surface for a per-escrow option; the new entry points are additive. |
| OpenZeppelin access/role modules | Not usable here (no `soroban-sdk` 27-compatible release) and would add the contract-level authority ADR 0002 rejects — see ADR 0006. |

## Tests

`contracts/escrow/tests/quorum.rs` (19 tests) covers: stored set/threshold,
release with exactly/all/more-than threshold approvals, too few approvals,
duplicate approvals (cannot satisfy the threshold), non-member approver, the
single-caller path on a quorum escrow, a listed approver that never signed
(auth is bound to the invocation), replay after settlement, refund with
approvals, duplicates/short thresholds on refund, the timeout refund with no
approvals, release after the deadline, single-releaser escrows behaving as
1-of-1, and creation-time validation (empty set, zero/oversized threshold,
duplicates, `MAX_RELEASERS` boundary and `+1`, nothing locked on rejection).
Single-releaser behaviour is additionally covered by the existing suites
(`create_escrow.rs`, `release_refund.rs`, `timeout_refund.rs`, `top_up.rs`).

## References

- Issue #119.
- Threat model T1, T2, T3, T4, T8 (`docs/threat-model.md`).
- Soroban authorization semantics: auth entries bind to the invocation and
  carry an expiration ledger, which is what makes the one-call design
  replay-safe.
