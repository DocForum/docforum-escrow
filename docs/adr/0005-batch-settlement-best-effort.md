# ADR 0005: Batch settlement is best-effort, not atomic

- Status: Accepted
- Date: 2026-10-09
- Issue: #16 (Phase E5)
- Supersedes: none
- Related: `docs/adr/0002` (per-escrow releaser), `docs/adr/0004`
(timeout refund), `docs/threat-model.md` T1

## Context

Threat model T1 is a compromised `releaser` key. The only on-chain
response is to *race the attacker*: use the same key to settle every
still-open escrow correctly before the attacker does. With one
transaction per escrow, that race is slow — the attacker can land
many transactions in the same time the defender lands one. Batch
settlement lets a releaser settle many escrows per transaction. It
also helps normal high-volume integrators (e.g. `docforum-core`)
settling a batch of fulfilled orders at once.

## Decision

Add `settle_many(caller, ops: Vec<(escrow_id, SettleOp)>) -> Result<Vec<SettleResult>, Error>`.

**The batch is best-effort, not atomic.** Each op is attempted in
order and reports its own outcome (`OkSettled`, `NotFound`,
`Unauthorized`, `NotFunded`). An op that fails does not abort the
batch; the remaining ops still run. The call as a whole only
returns an `Error` for a malformed batch (empty, or longer than
`MAX_BATCH_SIZE`), rejected before any transfer is attempted.

## Why best-effort and not atomic

An atomic batch would either abort the whole call on the first
failure, or roll back every transfer if any one failed. Both are
wrong for the T1 race:

1. **The race is against an attacker who is also settling.** By the
   time the defender builds a batch, some of those escrows may
   already be settled by the attacker. Those ops will fail
   `NotFunded`. With an atomic batch, a single already-lost escrow
   would cause the defender to roll back the whole thing — including
   the escrows they could still have won. That is the opposite of
   what the race response needs.
2. **The defender needs to know what landed.** Best-effort returns
   a per-op result, so the defender can immediately re-submit just
   the ops that failed for a recoverable reason (e.g. a
   transient token failure), and give up on the ones the attacker
   already won. An atomic batch gives one binary answer and no
   information about which ops would have succeeded.
3. **Atomicity across transfers isn't free.** An atomic batch
   would need to either pre-validate every op (extra reads, more
   resources, and still not race-safe — the attacker can land
   between the validation and the transfers) keep a rollback journal
   for every transfer. Best-effort avoids both.

Note that Soroban already gives us the atomic building block if
 someone wants it later: a caller can batch individual `release`/`refund`
invocations into one transaction and let the transaction fail as a
whole. `settle_many` is for the case where that is the wrong
tradeoff.

## Per-op auth and state checks

Auth is **not** a single batch-level check. Each op applies the
same rules as the single-op functions:

- `Release`: `caller == data.releaser` and `data.status == Funded`.
- `Refund`: `caller == data.releaser` or the `refund_after` deadline
  has passed, and `data.status == Funded`.

So a batch may mix escrows with different releasers; an op for an
escrow whose releaser is not `caller` fails `Unauthorized` without
affecting the others. This is the property the reviewer is asked to
check.

## Same escrow twice in one batch

The batch is applied in order, and each op writes the new status
to storage before the next op is read. So if the same escrow appears
twice, the second op sees the updated status and fails
`NotFunded`. This is the desired behavior — it makes double
settlement impossible even within a single batch, and the per-op
result makes it clear which one won.

## Batch size bound

`MAX_BATCH_SIZE = 20`. The bound exists because a batch is one
transaction and Soroban caps the resources a single transaction
may consume. Each op does a persistent storage read, a token transfer,
and a persistent storage write, so the cost is linear in the batch
size. Twenty is chosen as a conservative cap that leaves headroom
below the per-transaction CPU/instruction limits for a typical
SEP-41 transfer, while still being large enough to make the T1
race meaningfully faster than one-transaction-per-escrow. The
constant is public and tested (`tests/settle_many.rs`), so if a
future measurement shows the cap is too low or too high it can be
adjusted in one place. Exceeding it fails the whole call with
`InvalidBatch` before any transfer, so a too-large batch can't
partially apply.

## Consequences

- The contract surface grows by one function and two types
(`SettleOp`, `SettleResult`) — a breaking addition for the generated
  SDK bindings, so the SGK gets a minor version bump and a regen
  (see `ARCHITECTURE_ESSENTIALS.md`).
- The T1 response guidance in `docs/threat-model.md` changes from
  "one transaction per escrow" to "settle in batches of up to
  `MAX_BATCH_SIZE`, expecting some ops to fail and re-submitting
  the recoverable ones".
- No new privileged role and no new destination: an op only ever sends
  to the stored `payee` or `payer`, exactly like the single-op
  functions. I1, I2 and I3 in the threat model are unchanged.
- The batch is not a transaction-level guarantee of all-or-nothing;
  a caller that wants that should batch individual `release`/`refund`
  invocations in one transaction instead.

## Alternatives considered

- **Atomic batch.** Rejected — see "Why best-effort" above; a
  single already-lost escrow would roll back the whole response and
  the caller would learn nothing about which ops would have
  succeeded.
- **No batch function, just document that callers should batch
  individual invocations.** Rejected — works, but the contract
  can't bound the batch size or return a clean per-op result, and
  the SDK would have to reimplement the auth/state logic to give
  a consistent answer.
- **Best-effort with a continue-on-error flag.** Rejected — the
  flag would let a caller ask for atomic behaviour by setting it
  false, but that reintroduces the atomic failure mode and the
  extra code path for no new capability. If atomicity is wanted,
  the transaction layer already offers it.
