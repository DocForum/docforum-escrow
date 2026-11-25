---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] SDK recurring schedules (issue #468): `createSchedule`, `getSchedule`,
  `fundNext`, `cancelSchedule`, `approveScheduleAllowance`, and the pure
  `scheduleState` / `scheduleAllowanceNeeded` helpers in `sdk/src/recurring.ts`,
  with offline validation mirroring `create_schedule` and the first
  `fund_next`'s creation rules. Typed errors for codes 38 and 55–59. SDK only.
