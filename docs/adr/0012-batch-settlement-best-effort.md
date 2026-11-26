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
   entry points). A `Refund` op accepts the stored payee's voluntary-refund
   path at any time while funded, or opens to anyone once `refund_after` has
   passed, as `refund` does; it still pays only the stored `refund_to` and
   emits `PayeeRefunded` for the voluntary path.

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

### A hostile callback payee can block the batch (issue #367)

`notify_payee` is the payee's opt-in to `on_escrow_released` (ADR 0005).
The callback runs **after** the transfer and after the `Released` write, so a
callback that returns an error or burns the transaction budget cannot be
reported as a clean per-op `Err`: the invocation aborts and everything in the
batch is rolled back, including releases that already paid out. A payee
contract controls its own callback entirely, so it can fail on demand. Every
`settle_many` batch that includes one of its escrows then reverts, in full,
for as long as it likes. During the T1 race-to-settle that is a cheap denial
of service against every other escrow in the batch, paid for by the payee.

`tests/settle_many.rs::hostile_callback_payee_reverts_a_batch_of_valid_releases`
pins this: three valid releases and one rejecting callback in one batch leave
all four escrows `Funded` and no token balance changed.

**Mitigation — settle callback release ops individually.** Release escrows
whose creation set `notify_payee` in a single-op transaction each, and keep
them out of shared batches. A failing callback then reverts only its own
escrow, and the rest settle normally
(`::isolating_the_callback_escrow_lets_the_valid_releases_settle`). Refund
ops never invoke the payee callback (threat model T11), so a `Refund` op for
a `notify_payee` escrow can stay in a normal batch
(`::refund_ops_never_invoke_the_payee_callback`).

This is operational guidance because the contract cannot fix it without
changing callback semantics: a callback failure is a post-effect failure, and
swallowing it would let a release commit without notifying the payee that
opted in. Integrators therefore isolate on the caller side: the SDK's
`settleMany` already sends one `release`/`refund` transaction per operation,
so a callback failure is contained to its own op, and
`scripts/settle-outcomes.py` submits one escrow per transaction for the same
reason (see `docs/runbooks/releaser-compromise.md`).

**Proposed contract-side change (not implemented here; needs a contract PR).**
One of:

- A new batch action that skips the callback (for example `ReleaseSilent`),
  so a defender can settle a `notify_payee` escrow in a batch at the cost of
  the notification. The payee opted in to being notified, so this weakens
  the ADR 0005 promise and needs an explicit decision.
- Run the callback as a separate, per-op-optional step after the batch
  commits, which turns a post-effect failure into state the caller can retry
  instead of a revert. That changes the callback's ordering guarantee for
  single `release` too, so it is a contract-version event.

Either is deliberately out of scope for issue #367: it would change the
contract surface, `CONTRACT_VERSION`, the generated bindings and the callback
ADR, and the operational rule above already removes the DoS for callers that
follow the runbook.

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
- `create_escrows` had the same repeated-`require_auth` problem for batches of
  two or more items. It now authorizes `payer` once for the whole batch and
  remains atomic. Its `MAX_BATCH_SIZE` dropped from 50 to 16, because the same
  events budget is its binding limit: each worst-case item emits 684 bytes, so
  24 items exceed 16,384 bytes. `create_escrows` only ever worked for one item, so
  no working integration breaks.
