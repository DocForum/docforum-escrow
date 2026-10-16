# ADR 0005: fixed milestone schedules

**Status:** Accepted for issue #21
**Date:** 2026-10-16

## Context

An all-or-nothing escrow cannot pay a staged agreement without creating
separate escrows and linking them off-chain. Milestone amounts and their
sum should be auditable in one contract record, while the existing
`create_escrow` and `release` calls remain available to current callers.

## Decision

Keep `create_escrow`'s signature and behavior as the one-tranche API. Add
`create_milestone_escrow` with a fixed, ordered list of strictly positive
amounts whose checked sum must equal the funded `amount`. The schedule is
immutable after creation. Each milestone has an on-chain released flag.

Add `release_milestone(escrow_id, index, caller)`. Milestones may be
released in any order. The stored releaser must authorize every release;
an index can succeed only once. The legacy `release` continues to release
one-tranche escrows and rejects multi-tranche escrows, avoiding a call
that would silently bypass their schedule.

`Funded` means no tranche has been paid, `PartiallyReleased` means some
but not all have been paid, and `Released` means every tranche has been
paid. `refund` is allowed from `Funded` or `PartiallyReleased` and sends
only the total unreleased amount back to the stored payer. Previously
released tranches are final. Existing `refund_after` authorization rules
are unchanged and apply to this remaining balance.

The contract verifies the tranche sum before requesting payer auth or
transferring funds. The balance-delta check remains in force for the
entire funded amount. Soroban transaction atomicity ensures a failed
tranche transfer does not mark its flag or change status.

## Consequences

- The single-tranche surface stays source-compatible; milestone support
  is additive.
- `EscrowData` and `EscrowStatus` gain milestone state and a partial
  status. This is a new contract deployment and is not compatible with
  the already-deployed WASM storage layout. There is no upgrade path for
  existing deployments.
- `release_milestone` and `create_milestone_escrow` increase storage and
  invocation cost with the number of tranches. Callers should keep
  schedules small; this API does not impose an arbitrary protocol-level
  maximum.
- SDK wrappers and generated bindings should expose the additive methods
  in a follow-up release before SDK consumers depend on milestone
  escrows. Existing SDK users keep the one-tranche flow.

## Alternatives considered

1. **Allow arbitrary partial amounts.** Rejected: it makes the agreement's
   planned stages mutable at execution time and makes it harder to reason
   about the remaining obligation.
2. **Require milestones in order.** Rejected: independent deliverables
   may complete in a different order. Explicit per-index flags provide
   the same at-most-once guarantee without imposing that coupling.
3. **Change `create_escrow` to require a schedule.** Rejected: this would
   break callers and the current SDK. A separate entry point preserves
   the existing API.
