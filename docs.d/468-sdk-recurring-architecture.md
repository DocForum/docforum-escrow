---
file: ARCHITECTURE_ESSENTIALS.md
after: "const { escrowId, txHash } = await client.createEscrow({ payer, payee, token, amount, conditionRef, releaser, refundAfter, notifyPayee: true, refundTo, feeRecipient, feeBps });"
---
// Recurring schedules (issue #468): createSchedule → { scheduleId, txHash }; getSchedule → RecurringSchedule;
// fundNext(scheduleId, { source }) → { escrowId, txHash } (keeper, no payer signature); cancelSchedule({ scheduleId, payer });
// approveScheduleAllowance({ payer, token, amount, expirationLedger }) (allowance is per payer + contract, shared by all schedules);
// pure scheduleState(schedule, ledgerTime) → "due" | "waiting" | "complete" | "cancelled"; scheduleAllowanceNeeded(schedule).
