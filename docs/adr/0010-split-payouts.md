# ADR 0010: Split payouts from one escrow

**Status:** Accepted for implementation in issue #22

## Context

A single escrow may need to pay multiple independent recipients. Having an
integrator receive the whole amount and forward portions reintroduces
custody and creates an extra failure point.

## Decision

Add `create_split_escrow` with a bounded list of at most eight unique
`PayeeShare` entries. Each share is expressed in basis points, must be
positive, and all shares must total exactly 10,000. Keep `create_escrow`
as the one-recipient form and expose the recipient list in `get_escrow`.

On release, each recipient except the final one receives the floor of
`amount * basis_points / 10,000`; the final recipient receives the
remaining amount. This makes the sum exact, including for small amounts
that cannot be divided evenly. Transfer calls occur in one contract
invocation, so a recipient transfer failure rolls back the complete
release rather than leaving a partial payout.

## Consequences

- A release costs more resources as the recipient count grows. The
  eight-recipient bound controls that growth, but maximum-list resource
  consumption still needs measurement before production deployment.
- Adding recipient shares to `EscrowData` changes its stored/public shape.
  Existing deployed contracts are immutable; consumers must use a newly
  built and deployed contract and regenerated SDK bindings.
- This implementation is testnet-only until the independent security
  review in Phase E4 is complete.
