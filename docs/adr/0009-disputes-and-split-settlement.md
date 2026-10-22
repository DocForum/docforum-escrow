# ADR 0009 — Disputes, a per-escrow arbiter, and split settlement

- **Status:** Accepted (2026-10-20)
- **Phase:** E6 — SDK & integrator tooling (issue #73)
- **Deciders:** contract maintainers
- **Related:** [ADR 0001](0001-generic-escrow-not-healthcare-specific.md)
  (domain-blind contract), [ADR 0002](0002-per-escrow-releaser-set-at-creation.md)
  (per-escrow releaser), [ADR 0004](0004-timeout-refund-path.md) (timeout
  refund), [ADR 0006](0006-openzeppelin-stellar-library-evaluation.md) (no
  global access-control module), [ADR 0007](0007-in-contract-m-of-n-releaser-quorum.md)
  (M-of-N releasers), `docs/threat-model.md` T1, T3, T8.

## Context

Every settlement path so far is binary: `release` pays the payee in full,
`refund` returns everything to the payer. Integrators keep asking for the case
in between — the work was partly delivered and the parties disagree — and today
they resolve it off-chain by agreeing that one side will call `release` or
`refund`. That works only while both sides are cooperative; if one goes quiet,
the only on-chain escape is the `refund_after` timeout, which is all-or-nothing
in the *other* direction.

Issue #73 asks the SDK to expose dispute support "including split settlement".
The contract had no dispute surface at all, so the SDK cannot invent one: this
ADR adds the minimum contract surface the SDK needs.

Constraints carried in:

- **ADR 0001:** the contract decides *who* may act, never *why*. An arbiter is
  another "who", not a domain oracle; the contract never inspects
  `condition_ref` to decide a dispute.
- **ADR 0006:** no global admin. The arbiter is per-escrow data chosen by the
  payer at creation, not a contract-level role.
- **Threat model T3 / invariant I3:** each escrow settles at most once, and
  only one party can end up with the funds.
- **Threat model T8:** nothing here may widen *where* funds can go. A split
  pays only the escrow's stored `payer` and `payee`.
- **Backward compatibility:** existing escrows and the existing entry points
  must behave exactly as before, including their storage encoding and the
  committed test snapshots.

## Decision

### Surface

```rust
create_escrow_with_arbiter(payer, payee, token, amount, condition_ref,
                           releaser, refund_after, arbiter, notify_payee) -> u64
raise_dispute(escrow_id, caller)                                  -> Result<()>
resolve_dispute(escrow_id, caller, payer_bps, payee_bps)          -> Result<()>
settle(escrow_id)                                                 -> Result<()>
get_dispute(escrow_id) -> DisputeState
```

- `raise_dispute` may be called by the `payer`, the `payee`, or any of the
  escrow's `releasers`, only while the escrow is `Funded`. It moves the escrow
  to a new `Disputed` status.
- `resolve_dispute` may be called **only** by the stored arbiter, only while
  `Disputed`, and only **once**. It records the split as basis points
  (`payer_bps + payee_bps == 10_000`) and moves no funds.
- `settle` pays both recorded shares. It takes no caller and needs no auth, so
  it is permissionless.
- `EscrowStatus` gains `Disputed` (appended, so existing tags are unchanged).

### Storage

Dispute state lives under its **own** key (`DataKey::Dispute(id)`):

```rust
pub struct DisputeState {
    pub arbiter: Option<Address>,
    pub resolved: bool,
    pub payer_bps: u32,
    pub payee_bps: u32,
}
```

Putting `arbiter`/`split_bps` inside `EscrowData` would have changed the
encoding of every escrow ever created, rewriting all 69 committed test
snapshots and changing what `get_escrow` returns for pre-E6 escrows. A separate
key means pre-E6 escrows read back byte-for-byte identically, and
`get_escrow`'s shape stays stable — the read is additive via `get_dispute`.

`resolved` plus two `u32`s rather than `Option<SplitBps>`: an
`Option<contracttype struct>` field is not round-trippable by the soroban-sdk
27 derive under the `testutils` feature, so the tests would not compile.

### Why settle is permissionless

Once the arbiter has recorded the split, settlement is a deterministic transfer
of fixed amounts to fixed addresses — there is nothing left to decide and
nothing to redirect. Making it permissionless means a disappeared arbiter, or a
party who stops paying fees, cannot strand the funds. The arbiter's single
authorization is `resolve_dispute`, and it is not replayable (the status leaves
`Disputed`).

### Why a second resolution is rejected

A re-writable split would let the arbiter change the outcome after a party has
seen it, and would make "settle" a race against the next `resolve_dispute`.
One resolution per dispute, `AlreadyResolved` afterwards.

### Rounding

`payer_amount = amount * payer_bps / 10_000` (truncated) and
`payee_amount = amount - payer_amount`. The complement is paid rather than a
second rounded multiplication, so no dust is left behind in the contract and
`payer_amount + payee_amount == amount` for every input.

### Interactions with the existing rules

- **`release`/`refund` and the approval variants** all go through
  `check_funded`, so a `Disputed` escrow rejects them (`NotFunded`). An
  adjudication cannot be raced by a direct settlement.
- **`refund_after`** still opens the timeout refund, but only while `Funded`.
  After a dispute is raised, the arbiter decides; the timeout is not a way to
  bypass arbitration. Parties who want the timeout to stay available should not
  raise a dispute.
- **Payee acceptance gate:** `settle` does not require `accepted_at`. The
  arbiter's resolution is the authorization for the payout.
- **`notify_payee` callback:** invoked on `settle` when the payee's share is
  non-zero, after the transfers, with `(escrow_id, payee_amount)`. A failing
  callback reverts the whole settlement, exactly like `release`.

## Consequences

- Existing integrators are unaffected: the entry points they use, their
  storage encoding, and their error numbers are unchanged. New errors are
  appended (`NotDisputed = 21`, `InvalidSplit = 22`, `AlreadyResolved = 23`,
  `NotResolved = 24`).
- An escrow funded without `create_escrow_with_arbiter` can be disputed but
  never resolved; `get_dispute` reports `arbiter: None` so the SDK's
  `availableActions` never offers a resolution nobody can perform.
- Split settlement is expressed in basis points, so it always sends the whole
  escrow amount and needs no separate amount validation.
- `settle` emits a `settled` event with both paid amounts; `raise_dispute` and
  `resolve_dispute` emit `disputed` and `resolved` events, so indexers can
  follow an adjudication without reading storage.
- The SDK surface is additive-but-meaningful: `@docforum/escrow-sdk` 0.5.0 →
  0.6.0, with regenerated bindings and the pure `availableActions` helper.
