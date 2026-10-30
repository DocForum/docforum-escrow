# ADR 0013 — Reclaim storage for settled escrows

- **Status:** Accepted
- **Issue:** #48 (Phase E5)
- **Related:** ADR 0001 (generic escrow), ADR 0010 (payer cancel), ADR 0011 (pooled
  escrows), the CEI note on `settle()`

## Context

A settled escrow (`Released`, `Refunded` or `Cancelled`) stayed in persistent
storage forever as a full `EscrowData`: addresses, amount, `condition_ref`, the
releaser set and every optional field. Nobody can act on it any more; only its
status still matters. Each entry keeps costing persistent-entry rent and TTL
upkeep for data that is history, and history belongs in events.

Since the status-read optimization, every escrow also has a separate, tiny
`DataKey::Status(id)` entry (written at creation and again at settlement) that
`get_status` reads. That entry is exactly the "minimal tombstone" this ADR needs,
so no new storage type is introduced.

## Options

| | Delete everything | **Keep only `Status` (chosen)** | Keep everything |
| --- | --- | --- | --- |
| Rent after settlement | none | one tiny entry | full record |
| `get_status(settled id)` | `NotFound`, indistinguishable from "never created" | `Released` / `Refunded` / `Cancelled` | same |
| Meets the issue's goal | yes | yes | no |

**Delete everything** was rejected because `NotFound` would then mean two things
("never created" and "settled"), and anyone polling `get_status` after a
settlement would misread a success as a missing escrow. **Keep everything** is the
status quo the issue asks us to fix.

## Decision

Every terminal transition goes through `settle()` (release, refund, their quorum
variants, timeout refund and payer cancel). For an ordinary escrow it now:

1. Sets the terminal status and writes it to `DataKey::Status(id)`.
2. Removes `DataKey::Escrow(id)`, the full record.
3. Pays out / invokes the payee callback (writes still precede the external
   call), then publishes the existing `ESCROW` state event (`publish_state`) with
   the full record.

A failing transfer or callback rolls the whole invocation back, including the
removal and the event, so a failed payout never leaves an escrow marked settled.

Reads and calls afterwards:

- `get_status(id)` is unchanged and still answers from `Status`. `NotFound` now
  means only "never created".
- `get_escrow(id)` returns `NotFound` for a settled id (no signature change; the
  record no longer exists). Use `get_status` and the event log.
- `release`, `refund`, `top_up`, `accept`, `cancel` and `rotate_releaser` on a
  settled id still return `NotFunded`, as before, via `load()`, which treats a
  present `Status` entry with no record as settled.
- Error precedence on a settled id: authorization is no longer evaluated, because
  the releaser set is gone. Every caller, including a non-releaser, gets
  `NotFunded`; before this change a non-releaser got `Unauthorized`. Funded
  escrows are unchanged.
- **Pooled escrows are not reclaimed** (ADR 0011, `create_pooled_escrow`). They
  keep per-contributor records, a funding config and pull-based refunds, all of
  which read the escrow record after settlement. Their full record stays exactly
  as before; reclaiming them (including contributor records) needs its own
  decision.
- `NextId` is untouched: ids are monotonic and never reused.

## Consequences

- **Behaviour change:** `get_escrow` on a settled id returns `NotFound` (it used
  to return the settled record). The SDK's `getEscrow` documents this and a
  changeset marks it breaking.
- The `ESCROW` state event is now the only on-chain copy of a settled escrow's
  details, including top-ups folded into `amount`. It carries every field except
  `refund_to` and `release_not_before`, which were added after the event shape
  was fixed. Appending them to the event tuple is a separate, indexer-visible
  change (the indexer decodes exactly 12 fields) and is intentionally not done
  here.
- TTL / rent policy is unchanged (issue #10): the `Status` entry has the default
  TTL of any persistent entry.
- Existing deployments are unaffected until redeployed (see ADR 0005 on
  immutable contracts).
