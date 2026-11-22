bump: minor
---
Issue #289: add permissionless `close_failed_round` for zero-contribution
failed pools and transition a pooled escrow to `Refunded` on its final claim;
both paths emit the terminal `ESCROW` snapshot.
