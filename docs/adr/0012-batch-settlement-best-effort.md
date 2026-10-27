# ADR 0012 — Batch settlement: best-effort with per-op results

- **Status:** Accepted
- **Issue:** #29 (Phase E5)
- **Related:** threat model T1, ADR 0002 (per-escrow releaser), ADR 0004
  (timeout refund), ADR 0005 (release callback), ADR 0007 (M-of-N), ADR 0011
  (pooled escrows)

## Context

Threat model T1's only response to a leaked releaser key is to race the
attacker: settle every open escrow correctly before they do. One transaction
per escrow makes that race slow. High-volume integrators want the same thing
for ordinary settlement.

`main` already had a `settle_many(caller, escrow_ids)` from issue #74, but it
was release-only and called `release` once per id, which calls
`caller.require_auth()` again in the same frame. Any batch of two or more ids
failed with `Error(Auth, ExistingValue)`, so it never worked as a batch.

## Decision

`settle_many(caller, ops: Vec<(u64, SettleAction)>) -> Vec<Result<(), Error>>`
with `SettleAction = Release | Refund`.

1. **Authorization.** `caller.require_auth()` once for the whole batch. Each
   op then runs exactly the checks of the single-escrow entry point it
   mirrors, through shared helpers (`release_checks`, `refund_checks`), against
   *that escrow's* stored releaser set. A batch can never settle an escrow
   whose releaser is someone else: that op returns `Unauthorized`. M-of-N
   escrows with threshold > 1 return `ThresholdNotMet` (use the approval
   entry points). A `Refund` op opens to anyone once `refund_after` has
   passed, as `refund` does, and still pays only the stored `refund_to`.

2. **Best-effort, not atomic.** One result per op, in input order.
   - `Ok(())`: this call settled the escrow.
   - `Err(e)`: the op was rejected **before any state changed**; the escrow
     is exactly as it was. All of `settle()`'s pre-write checks
     (`release_not_before`, payee acceptance) are run before effects so they
     can't surface after a transfer.
   - The same escrow twice: the first op settles it, the second returns
     `NotFunded`.
   - A failure **after** an op's effects began cannot be a clean per-op
     `Err` — funds would have moved under an error. The only such case is an
     opted-in payee callback failing (ADR 0005); it aborts and reverts the
     whole batch (`CallbackFailed`). A token transfer that traps aborts the
     whole transaction anyway (host behaviour).

3. **Bound.** `MAX_SETTLE_OPS = 20`; larger batches fail `BatchTooLarge`
   (existing code 25) before anything happens. An empty batch returns an empty
   vector.

### Why best-effort

For T1 the defender wants as many correct settlements per transaction as
possible. With atomic semantics a single escrow the attacker already settled
(`NotFunded`) would revert the whole batch, and the defender would lose the
round. Best-effort lets the batch keep everything that still can be settled,
and the per-op results say exactly which ones landed. Integrators that need
all-or-nothing can check the results in simulation and only submit a batch
with no `Err`.

### Why 20 (measured)

Measured with the release WASM in the soroban-sdk 27 test host against the
Mainnet per-transaction limits it enforces (snapshot 2026-07-10), worst case:
every op a release to a distinct payee, `condition_ref` at its 64-byte
maximum.

| Ops | Events (limit 16,384 B incl. return value) | Write entries (limit 200) | Write bytes (limit 132,096) | Instructions (limit 400M) |
|---:|---:|---:|---:|---:|
| 1 | 656 | 4 | 1,276 | 0.9M |
| 10 | 6,560 | 22 | 10,096 | 5.6M |
| 20 | 13,120 | 42 | 19,896 | 12.0M |

Each release emits its full escrow state event plus the token's transfer
event, 656 bytes together, so the events budget is the binding limit: 25
releases would need 16,400 bytes and fail. 20 leaves about 20% headroom for
larger addresses or extra events. Every other resource stays under 25% of its
limit. `tests/settle_many.rs::max_batch_fits_mainnet_limits` re-sizes the
emitted events on every `cargo test` and fails if a future change to the event
payload eats the headroom.

## Consequences

- The old `settle_many(caller, escrow_ids)` signature is replaced. It was
  never usable for more than one id and no SDK method calls it, so no
  working integration breaks. Bindings are regenerated.
- The attacker in T1 can use the same entry point. It changes how fast a
  leaked key can act, not what it can do.
- `create_escrows` still has the same repeated-`require_auth` problem for
  batches of two or more items. Out of scope here; worth its own issue.
