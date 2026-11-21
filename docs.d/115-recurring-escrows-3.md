---
file: ARCHITECTURE_ESSENTIALS.md
after: "solvency(token) -> (balance, liabilities) // IMPLEMENTED (Phase E5, issue #39)"
---
create_schedule(payer, payee, token, amount, condition_ref, releaser, refund_after_seconds, period_seconds, total_periods, first_due) -> schedule_id // IMPLEMENTED (Phase E5, issue #115, ADR 0015) — recurring escrows funded through SEP-41 allowances; payer authorizes once, any keeper funds due periods; payer may cancel
fund_next(schedule_id) -> escrow_id // IMPLEMENTED (Phase E5, issue #115) — keeper-triggered; pulls exactly one period amount with transfer_from under the payer's allowance and creates a normal escrow; fails early, on exhaustion, or when complete/cancelled
cancel_schedule(schedule_id, payer) -> () // IMPLEMENTED (Phase E5, issue #115) — payer only; period escrows already created are unaffected
get_schedule(schedule_id) -> RecurringSchedule // read-only schedule record
