# Escrow state-machine model

This directory contains a finite TLA+ model of the escrow contract's actual behavior in `contracts/escrow/src/lib.rs`. The model is intentionally narrow and follows the implemented escrow rules, not a hypothetical dispute or milestone system that the repo does not contain.

## What it covers

- Funded, Released, and Refunded states
- Single-releaser settlement and M-of-N approval paths
- Optional timeout refunds via `refund_after`
- Payee-initiated voluntary refunds while `Funded` (ADR 0010)
- Earliest-release gating via `release_not_before`
- Payee acceptance gating for `requires_acceptance`
- Authorization checks for the releaser and timeout cases
- Same-ledger race windows where timeout refund and release can both become eligible at the same ledger time

## What it intentionally omits

The current contract does not implement a general dispute system, milestone settlement, or arbitration roles. This model therefore does not invent those features. Any future contract change that adds a new lifecycle state or settlement path must update the TLA+ model and re-run TLC.

## Model file and config

- `spec/Escrow.tla` — TLA+ specification
- `spec/Escrow.cfg` — TLC configuration

## TLC installation and run command

The checker used for this repo was downloaded from the official TLA+ release:

```bash
mkdir -p /tmp/tlaplus
curl -fsSL -H 'User-Agent: Mozilla/5.0' \
  -o /tmp/tlaplus/tla2tools.jar \
  https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
```

Then run:

```bash
cd /workspaces/docforum-escrow
java -jar /tmp/tlaplus/tla2tools.jar -config spec/Escrow.cfg spec/Escrow.tla
```

## Verified result

The model checked successfully with TLC 2.19 (official release v1.7.4):

- 123 states generated
- 60 distinct states found
- 0 states left on queue
- model checking completed without invariants or properties failing

## Same-ledger race modeling

The model explores release-vs-timeout races by representing both actions as enabled transitions at the same ledger timestamp when `refund_after` has been reached. This matches the contract rule that releaser settlement still wins if it lands before the timeout refund and that the timeout path becomes available only after the deadline while the escrow remains funded.

## Interpreting counterexamples

If a future model change produces a counterexample, inspect the trace in the order it occurred and compare it to the actual contract conditions in `contracts/escrow/src/lib.rs`. A counterexample usually means one of two things:

1. The model is wrong for the contract, or
2. the contract semantics changed and the spec needs to be updated.

Do not weaken invariants to hide a real contract behavior difference.

## Dependency mapping

| TLA+ action | Contract function | Source file | Notes |
|---|---|---|---|
| `CreateEscrow` | `create_escrow` / `create_escrow_release_time` | `contracts/escrow/src/lib.rs` | Creates a funded escrow with a single releaser and optional `refund_after` / `release_not_before` |
| `ReleaseEscrow` | `release` | `contracts/escrow/src/lib.rs` | Allowed only when the caller is the single releaser and the escrow is still funded |
| `ReleaseWithApprovals` | `release_with_approvals` | `contracts/escrow/src/lib.rs` | Thresholded quorum release using distinct approvers |
| `RefundEscrow` | `refund` | `contracts/escrow/src/lib.rs` | Releaser refund before the timeout; timeout path is modeled separately |
| `TimeoutRefund` | `refund` timeout branch | `contracts/escrow/src/lib.rs` | Anyone may trigger refund once `refund_after` is reached |
| `AcceptEscrow` | `accept` | `contracts/escrow/src/lib.rs` | Optional payee authorization for release gating |
| `AdvanceLedger` | Soroban ledger timestamp | `contracts/escrow/src/lib.rs` | Represents time progression; the contract itself uses the ledger timestamp |

## Updating the model

When the contract changes any of the following, update this spec and re-run TLC:

- status transitions
- authorization rules
- timeout conditions
- acceptance gating
- release/refund eligibility
- quorum settlement

