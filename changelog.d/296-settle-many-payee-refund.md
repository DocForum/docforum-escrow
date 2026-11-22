Issue #296 (Phase E5): aligned `settle_many` refund operations with the
single-escrow `refund` path. The stored payee can now initiate a voluntary
refund in a batch, with the same `PayeeRefunded` event and pooled-escrow
protection.
