---
file: README.md
after: "[`sdk-go/README.md`](sdk-go/README.md)."
---
The same client also wraps payee acceptance (`accept`, `cancel`,
`transfer_payee`), pooled escrows (`create_pooled_escrow`, `contribute`,
`claim_refund`, `get_pooled`, `get_contribution`) and the chunked batch entry
points (`create_escrows`, `settle_many`, with `MaxBatchSize`/`MaxSettleOps`
mirroring the contract's measured limits) — see issues #340, #341 and #344.
