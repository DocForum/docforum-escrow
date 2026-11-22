---
file: docs/threat-model.md
section: 3. Threats
---
### T115 — Keeper drains a schedule beyond the payer's authorisation · **High**

- **What an attacker can do:** `fund_next` is permissionless by design — anyone may call it. A keeper could try to pull more than the payer authorised: fund before a period is due, fund the same period twice, keep funding after the schedule is complete or cancelled, or drain an allowance the payer meant to cover only a few periods.
- **Impact:** funds leave the payer's balance for escrows the payer never agreed to fund, up to the full allowance. Each extra period is still a normal escrow (funds can only go to the stored payee or refund destination), so the loss is bounded by the allowance, not the payer's whole balance — but it is a loss all the same.
- **Mitigations to consider:**
  - [x] `fund_next` pulls exactly `amount` per call, only when the ledger timestamp has reached `next_due`, only while periods remain, and only while the schedule is not cancelled (`ScheduleTooEarly`, `ScheduleComplete`, `ScheduleCancelled`).
  - [x] A late trigger funds one period: `next_due` advances by exactly one `period_seconds` from the previous due time, so no single call ever creates several periods at once.
  - [x] The allowance is checked before the pull, and the token contract enforces the cap and its expiration ledger (`AllowanceExhausted`); an expired allowance reads as zero.
  - [x] The payer can stop funding at any time by cancelling (payer-signed) or by setting the allowance to zero.
  - [x] `transfer_from` is only ever called from `fund_next`: no other entry point spends the allowance. Tests: `tests/recurring.rs` (early trigger, allowance exhaustion, expired allowance, cancel, completion, one-period-per-call).
  - Consumer guidance: approve exactly `total_periods * amount` so the allowance itself caps the schedule completely.
