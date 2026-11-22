bump: minor
---
Issue #56: add immutable constructor-time per-token escrow amount caps and
the `AmountCapExceeded`/`InvalidAmountCap` errors. Creation, pooled funding,
batch creation, and `top_up` enforce the cap before token movement.
