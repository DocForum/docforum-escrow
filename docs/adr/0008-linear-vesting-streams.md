# ADR 0008: Linear vesting streams

**Status:** accepted for streamed escrows

## Context

Some escrows represent payment earned gradually over time. A releaser
should not need to submit many small payments, and a payee should be able
to withdraw earned funds without waiting for the entire schedule to end.

## Decision

Keep the existing `create_escrow` behavior unchanged. Add
`create_streamed_escrow` with a fixed positive total, start timestamp, end
timestamp, and optional cliff timestamp. Require `start < end`; a cliff
must be between start and end inclusive. Vesting is linear from start to
end. A cliff delays availability until its timestamp, then releases all
amount accrued since start. Before the start, vested amount is zero; at
or after the end, it is the full amount.

Vesting uses integer division with floor rounding. The implementation
decomposes multiplication into quotient and remainder terms so the
computation cannot overflow for positive i128 amounts and u64 timestamps.
Withdrawals require the payee's authorization and transfer only
`vested - withdrawn`; the running withdrawn total therefore cannot exceed
the escrow's fixed amount.

If `refund` is called before the stream settles, it pays the currently
vested but unwithdrawn amount to the payee and returns only the unvested
remainder to the payer. This closes the stream in one transaction and
avoids leaving a second party dependent on a future caller. After a
successful stream refund, `get_vesting` reports zero claimable amount.
The normal releaser-authorized `release` remains an early close path that
pays all remaining stream funds to the payee. Streamed escrows have a
fixed total; top-ups are not supported.

## Consequences

- `get_vesting` exposes the schedule, total, vested, withdrawn, and
  currently claimable amounts.
- `withdraw` adds a payee-authorized payout path while the escrow is
  funded.
- The refund path can transfer to both payee and payer in one call.
- Amounts round down at intermediate timestamps; all residual units vest
  by `end`.
- The new contract methods need regenerated SDK bindings before they are
  available from the TypeScript client.
