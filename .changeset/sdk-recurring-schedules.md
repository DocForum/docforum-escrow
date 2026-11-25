---
"@docforum/escrow-sdk": minor
---

Add recurring schedules to the SDK (issue #468; contract issue #115, ADR 0015).

- `client.createSchedule(params)` → `{ scheduleId, txHash }`, `client.getSchedule(id)` → typed `RecurringSchedule` (bigint `amount`, `nextDue`, `periodsFunded`, `totalPeriods`, `cancelled`, `refundAfterSeconds`), `client.fundNext(id, { source })` → `{ escrowId, txHash }` for keepers (no payer signature), and `client.cancelSchedule({ scheduleId, payer })`.
- Allowance: `scheduleAllowanceNeeded(schedule)`, `scheduleAllowanceExpirationLedger(schedule, latest)` and `client.approveScheduleAllowance({ payer, token, amount, expirationLedger })`, which calls the token's SEP-41 `approve(payer, escrowContract, amount, expirationLedger)`. The allowance is per payer and contract, shared by every schedule that payer has here.
- Pure `scheduleState(schedule, ledgerTime)` → `due | waiting | complete | cancelled`, using `fund_next`'s own checks and `<` comparison; `remainingPeriods(schedule)`.
- `createSchedule` validates offline (`ScheduleParamsError`, named after the contract error), including the creation rules the contract only applies at the first `fund_next`.
- New typed errors: `PausedError` (38), `ScheduleTooEarlyError` (55), `ScheduleCompleteError` (56), `ScheduleCancelledError` (57), `AllowanceExhaustedError` (58), `InvalidScheduleError` (59). They subclass `ContractError`, so existing `code` checks are unaffected.

Additive; no contract change.
