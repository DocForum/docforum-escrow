# ADR 0011: Batch settlement is best-effort, not atomic

## Status
Accepted (Phase E5, issue E5)

## Context

Threat model T1 (a leaked releaser key) says the only response is to
outrun the attacker: settle every open escrow correctly before the
attacker does. One transaction per escrow makes that race slow. We need a
way to settle many escrows in a single transaction. The same primitive also
helps normal high-volume integrators clear a backlog cheaply.

The new entry point is `settle_many(caller, ops)`, where each op is a
`(escrow_id, Release|Refund)` pair. The open question is what happens when
one op in the batch is invalid (bad auth, wrong status, already settled,
etc.).

## Decision

The batch is **Best-effort**, not atomic. Each op is evaluated
defensively and independently; one failing op does not roll back the ops
that already succeeded. `settle_many` returns a per-op result vector
(`Vec<SettleResult>`) in the same order as the input ops, so the caller
can tell exactly which escrows settled and which did not, and why.

## Why best-effort

1. **T4 race.** The reason this function exists is to outrun an attacker
who has stolen a releaser key. In an atomic batch, a single contented
escrow (e.g. the attacker just refunded it, or the caller is not the
releaser of one escrow in the set) would cause the entire batch to
fail. The defender would have to resubmit and lose time -- exactly the
window the attacker wants. Best-effort lets the defender settle every
contented escrow in one shot and only re-try the ones that did not land.

2. **High-volume integrators.** A backlog cleanup typically contains a
mix of ready-to-settle and already-settled escrows. Atomic semantics
would force the caller to pre-filter the list offline, racing against
state changes and adding an extra round-trip. Best-effort lets the contract
be the source of truth for "which ones actually settled".

## Why not atomic

Atomic semantics are the right default for a single escrow -- a
release is all-or-nothing. But a batch is a *collection* of independent
settlements, not one logical operation. Treating it as atomic would
make a single contented escrow a deni-of-service vector against the
defender.

## Per-op auth and state checks

Even though the batch is best-effort, each op is still checked
strictly:

- The caller must be a releaser of *each* escrow it tries to settle.
A single batch cannot settle escrows whose releaser is someone else.
Each op's authorization is checked individually against that escrow's
stored releasers + threshold.

- Each escrow must be in the `Funded` state at the moment its op is
evaluated. Status is re-read per op, so a prior op in the same batch
that settled the same escrow makes the second op fail with `NotFunded`.

- The same escrow appearing twice in one batch is not a special case:
the first op succeeds, the second op sees a non-`Funded` status and fails
with `NotFunded`. This is the same rule as a double release in two
separate transactions.

## Batch size bound

The batch size is bounded by a constant `MAX_SETTLE_BATCH`
derived from measured resource limits on testnet. The constant is
enforced in the contract (`BatchTooLarge`) and mirrored in the SDK
(`MAX_SETTLE_BATCH`) so callers fail fast. The current value is set
to the largest batch that fits comfortably under the testnet transaction
resource ceiling with the worst-case payload (all releases, all callbacks
enabled).

## Consequences

- `settle_many` is not a replacement for `transaction`-level atomicity.
Callers that need all-or-nothing must still call `release`/`refund` one at
a time.

- Events are emitted per successful op, exactly as if the op had been
called through the single-escrow entry point. Off-chain indexers need no
special case.

- The return value is the authoritative record of what happened. A caller
that ignores it has no one else to blame.

- The T1 response guidance in `docs/threat-model.md` is updated to
recommend `settle_many` for the race instead of a loop of single
`release`/`refund` calls.

## References

- Threat model T1 -- `docs/threat-model.md`
- ADR 0002 -- per-escrow releaser
- ADR 0007 -- M-of-N releaser quorum
