Issue #468 (Phase E6): the TypeScript SDK now wraps recurring schedules
(contract #115, ADR 0015): `createSchedule`, `getSchedule`, `fundNext`,
`cancelSchedule` and `approveScheduleAllowance`, plus the pure helpers
`scheduleState` (`due | waiting | complete | cancelled`, matching `fund_next`'s
check order and `<` comparison against ledger time), `scheduleAllowanceNeeded`,
`scheduleAllowanceExpirationLedger` and `remainingPeriods`, in the new
`sdk/src/recurring.ts`. `createSchedule` validates offline what
`create_schedule` rejects (amount, `InvalidSchedule`, `conditionRef` counted in
UTF-8 bytes, the allowlist once read). It also checks the creation rules the
contract only applies when `fund_next` creates the first period escrow (payee,
releaser and payer not the contract, a positive `refundAfterSeconds`, no
`next_due` overflow), so a misconfigured schedule fails before it is recorded.
New typed errors for codes 38 and 55–59. No contract change. The opt-in
testnet case is skipped by default because the recorded testnet deployment
predates #115.
