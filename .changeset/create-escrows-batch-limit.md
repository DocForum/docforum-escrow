---
"@docforum/escrow-sdk": patch
---

Lower `MAX_BATCH_SIZE` from 50 to 16 to match the contract's `create_escrows` limit, which is set by Mainnet's contract events budget.
