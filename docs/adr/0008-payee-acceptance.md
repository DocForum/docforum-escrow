# ADR 0008: Opt-in payee acceptance

**Status:** Accepted for issue #25
**Date:** 2026-10-16

## Decision

Escrow creation can opt into a payee acceptance gate through
`create_escrow_with_acceptance(..., requires_acceptance)`. The existing
`create_escrow` entry point remains acceptance-opt-out by default.

The designated payee can call `accept` once while the escrow is funded.
The contract stores the ledger timestamp and returns both the flag and
timestamp from `get_escrow`. `release` is blocked until acceptance for
opted-in escrows. `refund` remains available to the releaser at any time
while funded, and to anyone after `refund_after`; it is not blocked by the
acceptance flag. This contract has no payer-cancellation operation, so
acceptance currently changes release authorization only.

## Consequences

Acceptance proves the payee's key authorized an on-chain acceptance of
the escrow terms as represented by the opaque `condition_ref`; the
contract does not interpret or validate those terms. The opt-in avoids
changing existing integrations. Consumers must use the new creation
method when they require acceptance and should display the stored
timestamp from `get_escrow`.
