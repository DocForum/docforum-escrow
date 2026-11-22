# ADR 0015 — List escrows by payer or payee

- **Status:** Accepted
- **Issue:** #33 (Phase E5)
- **Related:** ADR 0013 (reclaim storage), the `ESCROW` lifecycle event
  (issue #9), the SubQuery indexer and typed query client (issue #87)

## Context

Escrows are stored one record per id (`DataKey::Escrow(id)`), with `NextId` in
instance storage and no address key. Nothing in the contract maps an address to
the escrows it is the payer or payee of, so answering "all escrows for X" means
knowing every id and calling `get_escrow` on each. The issue asks for a
paginated `list_by_payer` / `list_by_payee`, *or* an event-based off-chain
index, with the choice made here.

## Options

| | On-chain per-address index | **Event-based off-chain index (chosen)** |
| --- | --- | --- |
| Query | read the address's id vector, then N records | indexer lookup, filter on `payer`/`payee` |
| `create_escrow` cost | grows with that address's escrow count | unchanged |
| New storage | two persistent entries per create, one per side | none |
| Rent / TTL | a new unbounded entry family to extend and pay rent on | none |
| Cursor stability | ids only appended, so stable | ledger order, stable |
| Contract change | new entry points, storage layout, redeploy | none |

### What the on-chain index would cost (measured)

Every `create_escrow` would read, append to and write back two vectors — the
payer's and the payee's — each holding one `u64` id per escrow. A `Vec<u64>` is
`4 + 8N` bytes of XDR (4-byte length, 8 bytes per id), so the entry, its write
bytes and its rent grow linearly in how many escrows the address has.

The contract's per-invocation budgets are hard limits and the existing features
are capped against them: the measured Mainnet limits are 132,096 write bytes
and 16,384 event bytes per transaction, which is why `settle_many` is limited
to `MAX_SETTLE_OPS = 20` and `create_escrows` to `MAX_BATCH_SIZE = 16`
(ADR 0012). A per-address index is the one thing that can't be capped that way
without refusing a busy payer's next escrow. For scale, a payer with 8,000
escrows holds a 64,004-byte index entry, so one `create_escrow` for that payer
would write about half the whole per-transaction write-byte budget — and
nothing caps the count.

It isn't free at the low end either. `create_escrow` already measures 494,344
instructions and 167,118 bytes of memory, and an extra persistent entry raises
creation cost — moving `NextId` to a persistent entry was tried and rejected
for exactly that reason. A single full-record persistent read costs 33,709
instructions more than a compact one (the `get_status` optimization). All three
figures are from the committed `benchmarks/resource-profile.md`.

### Why off-chain (chosen)

The `ESCROW` event (issue #9) is already emitted on `created`, `released`,
`refunded` and `cancelled`, with topic `("ESCROW", action, escrow_id)` and a
full-state payload that includes `payer` and `payee`
(`ARCHITECTURE_ESSENTIALS.md` § Events). The SubQuery indexer (issue #87)
already decodes it into `Escrow` / `EscrowEvent`; because it replays the event
log it already has an append-only, cursor-paginated view with the parties
attached. Listing by address is then a filter on that existing index, not a
contract feature.

## Decision

**Implement nothing in the contract.** The events carry what an indexer needs to
answer both queries: no `list_by_payer` / `list_by_payee`, no index vectors, no
storage-layout change, no redeploy.

The bundled path is the indexer plus the typed client. `EscrowIndexerClient`
gains optional `payer` / `payee` filters on `listEscrows`, which pass through to
the indexer's `filter`. The indexer's schema already stores both fields, so the
indexer itself needs no change; operators run it and pass its URL as
`indexer/README.md` describes.

## Consequences

- No contract change: `create_escrow` keeps its measured cost, `CONTRACT_VERSION`
  is untouched, no bindings change and no redeploy.
- Coverage is the indexer's, not the chain's. An escrow created before the
  operator's configured start ledger is not listed, so that ledger must be set
  no later than deployment (already required by issue #87). A query also returns
  indexer state, which trails the chain by its own indexing lag — not a
  consensus read.
- The `ESCROW` event omits `refund_to` and `release_not_before` (ADR 0013).
  Neither is needed to answer "escrows for an address", so this does not block
  the query.
- SDK-minor and additive: two optional fields on an existing options object.
