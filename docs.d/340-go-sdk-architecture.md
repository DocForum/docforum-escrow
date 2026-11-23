---
file: ARCHITECTURE_ESSENTIALS.md
after: "quickstart deployment."
---
Beyond the original five calls it also wraps payee acceptance (`accept`,
`cancel`, `transfer_payee`), pooled escrows (`create_pooled_escrow`,
`contribute`, `claim_refund`, `get_pooled`, `get_contribution`) and the batch
entry points (`create_escrows`, `settle_many`), chunking at the contract's
`MAX_BATCH_SIZE` and `MAX_SETTLE_OPS` (issues #340, #341, #344). No contract
change was involved.
