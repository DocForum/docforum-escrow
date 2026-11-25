---
file: README.md
section: Pooled escrows
---
### Recurring escrows

A recurring schedule funds one escrow per period from the payer's SEP-41
allowance (issue #115, [ADR 0015](docs/adr/0015-recurring-escrows-token-allowances.md); SDK
issue #468). The payer records the terms and grants the escrow contract an
allowance once. After that, any keeper funds each due period without the payer
signing again.

```ts
import { scheduleAllowanceExpirationLedger, scheduleAllowanceNeeded, scheduleState } from "@docforum/escrow-sdk";

const { scheduleId } = await client.createSchedule({
  payer, payee, token, releaser,
  amount: 250_000n, conditionRef: "sub-42",
  periodSeconds: 2_592_000n, totalPeriods: 12, firstDue: 1_900_000_000n,
  refundAfterSeconds: 86_400n, // relative: each period escrow's refundAfter = its funding time + 1 day
});

// The allowance is per payer and contract (and token), shared by all of this
// payer's schedules here, and `approve` replaces it: sum what each one needs.
const schedule = await client.getSchedule(scheduleId);
const latest = await client.getLedgerTime();
await client.approveScheduleAllowance({
  payer, token,
  amount: scheduleAllowanceNeeded(schedule), // remaining periods × amount
  expirationLedger: scheduleAllowanceExpirationLedger(schedule, latest),
});

// Keeper loop: compare against ledger time, never the local clock.
if (scheduleState(await client.getSchedule(scheduleId), (await client.getLedgerTime()).closeTime) === "due") {
  const { escrowId } = await client.fundNext(scheduleId, { source: keeper }); // one period per call
}

await client.cancelSchedule({ scheduleId, payer }); // funded periods are unaffected
```

`fundNext` funds exactly one period per call. A late keeper leaves the next
period due immediately, so check `scheduleState` again. Failures are typed:
`ScheduleTooEarlyError`, `ScheduleCompleteError`, `ScheduleCancelledError`,
`AllowanceExhaustedError` (the allowance is too small or expired, and the payer
must `approve` again) and `PausedError`, none of which the SDK retries.
`createSchedule` also runs offline the creation rules the contract only checks
at the first `fund_next`, so a misconfigured schedule fails before it is
recorded. The recorded testnet deployment predates recurring escrows.
