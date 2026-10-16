# ADR 0006: Immutable per-token escrow caps

**Status:** accepted for the guarded beta

## Context

The contract holds all escrows for a token in one shared balance. A
deployment-time cap limits the amount one escrow can commit, including
later top-ups, and gives a staged launch a fixed bound that cannot be
raised by an administrator key.

## Decision

The constructor receives a map from token contract address to a positive
maximum amount in that token's smallest units. A token without an entry is
not accepted. `create_escrow` and `top_up` enforce the cap; top-ups also
require the original payer and an escrow that remains funded. A top-up
cannot make the total escrow amount exceed the configured maximum.

There is no batch-creation entry point today. If one is added, it must
apply the same per-token check to every requested escrow before accepting
the batch.

## Staged launch plan

For each allowlisted token, choose a cap in its smallest units based on
the token's decimals and the intended initial beta exposure. Start at
25% of the reviewed beta target, increase to 50%, then 100% only after
the preceding stage has been monitored and reviewed. Each increase
requires deploying a new contract with a new cap map and moving new
escrows to its new contract ID; the existing deployment remains capped
and must settle its outstanding escrows before it is retired. This is a
conservative operational plan, not a mainnet authorization: the security
review in Phase E4 remains a hard prerequisite for any mainnet use.

## Consequences

- Caps are immutable for a deployment, which limits unilateral changes.
- An omitted token is rejected, avoiding accidental uncapped assets.
- Redeployment changes the contract ID and requires an explicit
  migration and settlement plan.
- Caps limit individual escrow exposure, not aggregate liabilities in a
  shared token pool; the solvency guard and token allowlist remain
  necessary.
- The `create_escrow` constructor surface and `top_up` method require
  regenerated SDK bindings before the TypeScript client can expose them.
