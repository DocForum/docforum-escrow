bump: patch
---
Issue #38: check the shared token balance before settlement and return the
existing `PoolInsufficient` error when post-creation clawback or another pool
shortfall leaves the requested payout unavailable.
