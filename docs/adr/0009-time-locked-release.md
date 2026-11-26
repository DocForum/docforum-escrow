# ADR 0009: Optional `release_not_before` guard

Status: Accepted (2026-10-16)

## Context

Some escrows must not pay out before an agreed time. Without an on-chain
guard, the releaser can submit `release` immediately and the timing promise
exists only in the integrator. Issue #43 asks for a contract-enforced,
inspectable release time while keeping the contract generic and preserving
the existing refund path.

## Decision

1. `create_escrow_release_time` accepts an optional unix timestamp.
   The existing `create_escrow` entry point remains unchanged and preserves
   immediate-release behavior.
2. A specified timestamp cannot be earlier than the current ledger timestamp.
   When `refund_after` is also set, `release_not_before` must be no later
   than it. Equality is permitted: at that timestamp both release and
   timeout refund are eligible, with the first transaction in ledger order
   settling the escrow.
3. `release` remains restricted to the stored releaser and a `Funded`
   escrow, and additionally requires `ledger.timestamp() >= release_not_before`.
   The exact boundary is inclusive.
4. `refund` is unchanged. The delay is escrow-wide, not per-tranche, because
   this contract currently has no milestone or tranche model.
5. `get_escrow` includes the stored value so either party can inspect the
   timing rule. No release deadline changes destination or authority.

## Consequences

- `EscrowData` and `create_escrow` change, so deployments must use newly
  generated WASM; existing immutable deployments are unaffected.
- The generated TypeScript contract client must be regenerated from that
  WASM before the SDK can decode the new field.
- An escrow-wide delay may be too coarse for future milestone payments. A
  later tranche design must define its own per-tranche timing semantics.
- This is a timing gate, not a new identity or reason check. The contract
  remains domain-blind under ADR 0001.
