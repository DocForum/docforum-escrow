# ADR 0013: Immutable per-token escrow caps

**Status:** accepted for the guarded beta (issue #56)

## Context

The contract holds all escrows for a token in one shared balance. A
deployment-time cap limits the amount one escrow can commit, including
later top-ups, and gives a staged launch a fixed bound that cannot be
raised by an administrator key. The deployment already takes an immutable
token allowlist (`allowed_tokens`, issue #36); caps sit alongside it.

## Decision

The constructor is `__constructor(allowed_tokens, maximum_amounts)`, where
`maximum_amounts` maps a token contract address to a positive maximum in
that token's smallest units. A non-positive cap fails deployment.

- **Empty map: no caps.** This mirrors the allowlist, where an empty list
  allows any token. It keeps existing deployments, tests and integrations
  working with one extra empty argument.
- **Non-empty map: a token without an entry is rejected**
  (`TokenCapNotConfigured = 36`), so a capped deployment cannot accidentally
  accept an uncapped asset.
- **Enforcement points**, all rejecting with `AmountCapExceeded = 37` before
  any transfer:
  - every creation path, via the shared `create_escrow_inner` — single,
    release-time, acceptance-gated, M-of-N releaser, and each item of
    `create_escrows` (the batch is atomic, so one over-cap item rejects
    the whole call);
  - `top_up`, against the escrow's total after the top-up;
  - `create_pooled_escrow`, against the funding target. Contributions can
    never exceed the target, so this bounds a pooled escrow's total.

Code 35 is deliberately left unused here because the pre-payout solvency
check proposed in issue #38 claims it.

## Staged launch plan

For each allowlisted token, choose a cap in its smallest units based on
the token's decimals and the intended initial beta exposure. Start at
25% of the reviewed beta target, increase to 50%, then 100% only after
the preceding stage has been monitored and reviewed. Each increase
requires deploying a new contract (`scripts/deploy --maximum-amounts
C...=AMOUNT,...`) and moving new escrows to its contract ID; the existing
deployment remains capped and must settle its outstanding escrows before
it is retired. This is a conservative operational plan, not a mainnet
authorization: the Phase E4 security review remains a hard prerequisite
for any mainnet use.

## Consequences

- Caps are immutable for a deployment; there is no setter and no admin.
- Redeployment changes the contract ID and requires an explicit
  migration and settlement plan.
- Caps limit individual escrow exposure, not aggregate liabilities in a
  shared token pool; the token allowlist and balance-delta checks remain
  necessary.
- Every deployment now passes a second constructor argument. The SDK
  bindings were regenerated; `scripts/deploy` and the local-network SDK
  workflow pass an empty map unless caps are requested.
