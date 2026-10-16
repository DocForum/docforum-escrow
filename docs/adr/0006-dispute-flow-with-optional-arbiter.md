# ADR 0006: Optional arbiter dispute flow

## Status

Accepted for issue #24.

## Context

The original escrow has no on-chain voice for either payer or payee after
creation. An optional, independent arbiter provides a bounded resolution
path without changing escrows created through the original entry point.

## Decision

- `create_escrow` remains unchanged and stores no arbiter. A new
  `create_escrow_with_arbiter` entry point accepts one arbiter address.
  The arbiter must be different from both payer and payee.
- Either payer or payee may raise a dispute while the escrow is `Funded`.
  A stranger cannot raise one, and an escrow without an arbiter cannot
  enter the dispute flow.
- Raising a dispute changes status to `Disputed`. Both ordinary release
  and refund are unavailable in that state, including the timeout refund.
  The deadline does not pause or move; the dispute simply prevents either
  unilateral settlement path until the arbiter resolves it.
- Only the stored arbiter may resolve an active dispute, choosing either
  `Release` (funds go to the stored payee) or `Refund` (funds go to the
  stored payer). The arbiter cannot redirect funds or resolve an
  undisputed escrow.
- If release and dispute are submitted in the same ledger, the first
  successful invocation wins. A later dispute cannot reverse release; a
  successful dispute prevents release and refund.

## Consequences

Escrows created with the original entry point retain the existing
releaser-only and timeout behavior. Opt-in escrows gain a dispute freeze
and an explicit neutral settlement route. A dispute can remain frozen
indefinitely if the named arbiter is unavailable; integrators must choose
an arbiter they trust to remain available.

The contract record and status enum change, so generated client bindings
must be regenerated and consumers must handle `Disputed`. The contract is
immutable after deployment; deployments use a new contract ID.
