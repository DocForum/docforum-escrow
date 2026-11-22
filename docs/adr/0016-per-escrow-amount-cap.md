# ADR 0016: Per-escrow amount caps for a guarded mainnet beta

## Status

Accepted for the guarded mainnet-beta design; deployment remains blocked by
the repository's testnet-only hard rule until the security-review milestone.

## Decision

The escrow constructor accepts an immutable list of `(token, max_amount)`
pairs. A listed token cannot have more than `max_amount` held by one escrow.
The cap is checked against the complete amount at ordinary and streamed
creation, every item in batch creation, pooled funding targets and
contributions, and `top_up`. A token absent from the list is uncapped, while
the existing allowlist remains the separate control for disallowed tokens.

Caps must be positive and a token may appear only once. Rejected deposits fail
before their token transfer, preserving the existing checks-before-effects
ordering. The new cap failure is represented by the append-only
`AmountCapExceeded` contract error.

## Staged-launch plan

The first guarded mainnet beta deployment should set conservative caps per
supported token based on the reviewed launch budget. The exact values belong
to the deployment record, not the contract source. Raising a cap requires a
new deployment with a new immutable constructor configuration and an explicit
migration/rollout decision; the deployed instance is never edited in place.
Deployments should keep the allowlist and cap table aligned, verify both on
chain before accepting funds, and monitor cap failures as a signal to review
the next staged limit.

## Consequences

The constructor ABI changes, so callers must supply the cap table (an empty
table preserves uncapped behavior). Existing escrow records are unchanged;
the cap applies only to new funding and aggregate top-ups. SDK bindings and
deployment tooling must be regenerated for the constructor surface.
