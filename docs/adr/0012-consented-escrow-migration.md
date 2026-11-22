# ADR 0012: Consented migration between immutable escrow deployments

- **Status:** Accepted (2026-11-22)
- **Phase:** E5 — Contract features (issue #117)
- **Related:** [ADR 0005](0005-immutable-contract-and-redeploy-migrations.md)

## Context

Immutable deployments protect escrow rules, but a redeploy otherwise leaves
funded escrows on the old contract until they settle. An integrator may need
to move a live escrow to a reviewed successor while preserving its parties,
configuration and token balance.

## Decision

The receiving deployment accepts a `trusted_sources` address allowlist in its
constructor. `export_to` is available only on the new code and requires the
stored payer and sole releaser to authorize. It calls the target's
`import_from(source, source_escrow_id, data)`, transfers the exact amount from
the source contract to the target, and marks the source record `Migrated`.
`import_from` requires the source contract authorization and accepts only a
funded, non-pooled payload that passes the receiving deployment's validation.

The call is one Soroban transaction. A failed target validation or token
transfer rolls back the target record, source state and funds together. No
administrator, upgrade key, or arbitrary payout destination is introduced.

## Limits and rollout

Pooled escrows are excluded because their per-contributor records are not in
the single escrow payload. Current testnet deployments cannot participate:
their WASM predates these entry points. Integrators should keep old contract
IDs configured and settle those escrows under their original rules. A new
deployment must list each old source address explicitly at construction.
