bump: patch
---
Issue #296: align `settle_many` refund operations with the single-escrow
`refund` path so the stored payee can voluntarily refund a funded escrow;
the batch emits the same `PayeeRefunded` event and keeps pooled escrows
excluded from push refunds.
