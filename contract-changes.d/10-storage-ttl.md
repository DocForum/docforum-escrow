bump: minor
---
Issue #10: storage TTL management (threat model T6). Every entry point extends the instance TTL; escrow and status entries are extended to at least ~180 days or through `refund_after` plus a 30-day grace (capped at the network maximum), and settled escrows keep a shorter TTL. `DataKey` is now public so tests can inspect entry TTLs.
