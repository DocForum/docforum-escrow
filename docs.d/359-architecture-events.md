---
file: ARCHITECTURE_ESSENTIALS.md
after: "- `accepted` — topic `("accepted", escrow_id)`, payload `(payee, accepted_at)`"
---
- `pay_xfer` — topic `("pay_xfer", escrow_id)`, payload `(old_payee, new_payee)`
- `contrib`  — topic `("contrib", escrow_id)`,  payload `(payer, amount, funded)`
- `claimed`  — topic `("claimed", escrow_id)`,  payload `(contributor, refund_amount)`
- `PayeeRefunded` — topic `("PayeeRefunded", escrow_id, payer, payee)`, payload `(amount)`
- `Paused`/`Unpaused` — topic `("Paused", admin)` / `("Unpaused", admin)`, payload `()`
