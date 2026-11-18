---
"@docforum/escrow-sdk": patch
---

Regenerate contract bindings for the new `settle_many(caller, ops)`
contract signature (issue #29): ops are `[escrowId, SettleAction]` pairs
(`Release` | `Refund`). No hand-written SDK method changes.
