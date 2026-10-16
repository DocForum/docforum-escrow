# ADR 0006: Index escrows from lifecycle events off-chain

**Status:** Accepted

## Context

Consumers need to list escrows by payer or payee. The contract currently
supports lookup by escrow id. Adding an on-chain address-to-escrow vector
would make each `create_escrow` pay for a growing write set, require rent
management for every index entry, and need cursor semantics for mutable
lists. A busy address would make creation increasingly expensive and could
eventually hit storage limits.

## Decision

Keep the contract lookup keyed by escrow id and build payer/payee views from
the `created`, `released`, and `refunded` contract events. The `created`
event carries the full initial record and indexes the escrow id, payer, and
payee as topics. Terminal events carry the same address and id topics plus
token and amount. An indexer can create the address indexes from `created`
and update status from terminal events without repeatedly reading contract
storage.

Consumers should treat `(network, contract id, escrow id)` as the stable
record key, process events idempotently, and reconcile a record with
`get_escrow` when recovering an index. Pagination and ordering belong in the
indexer's database; new escrows do not mutate earlier cursors. The indexer
must follow the network's finalized ledger stream and persist its last
processed ledger so it can recover after restarts.

## Alternatives considered

### On-chain per-address vectors

This allows direct contract reads, but payer and payee indexes need separate
entries. Every escrow creation would write several persistent values and
extend their TTL. The vectors grow without a natural bound, require
compaction or pagination rules, and increase the cost of the core escrow
operation. This trade-off is rejected for the current contract.

### Keep only escrow-id lookup

This avoids extra storage but leaves every consumer to scan all ids or rely
on an undocumented event format. The new lifecycle events make the off-chain
indexer path explicit while preserving bounded on-chain writes.

## Consequences

- `create_escrow`, `release`, and `refund` emit additive public events.
- Existing contract calls and storage layout do not change.
- A payer/payee listing depends on an indexer; the contract remains the
  authoritative record and `get_escrow` remains the reconciliation path.
- Events and their topics are public and permanent. Integrators must not put
  sensitive material in `condition_ref`.

## References

- Issue [#33](https://github.com/DocForum/docforum-escrow/issues/33)
- Event format follow-up [#9](https://github.com/DocForum/docforum-escrow/issues/9)
