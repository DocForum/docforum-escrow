bump: minor
---
Issue #115: recurring escrows funded through token allowances (ADR 0015). New `create_schedule`/`fund_next`/`cancel_schedule`/`get_schedule` entry points, `RecurringSchedule` storage, and `ScheduleTooEarly`, `ScheduleComplete`, `ScheduleCancelled`, `AllowanceExhausted`, `InvalidSchedule` errors; period escrows are created through the existing creation path, so no existing entry point changes.
