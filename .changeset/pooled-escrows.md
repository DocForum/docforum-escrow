---
"@docforum/escrow-sdk": minor
---

Add pooled escrows funded by multiple payers (issue #113, `docs/adr/0011`).
New `client.createPooledEscrow({ creator, payee, token, fundingTarget,
conditionRef, releaser, fundingDeadline })`, `client.contribute({ escrowId,
payer, amount })`, `client.claimRefund({ escrowId, contributor })`, plus
read-only `client.getPooled(escrowId)` (`{ fundingTarget,
fundingDeadline }`) and `client.getContribution(escrowId, contributor)`
(`{ amount, refunded } | undefined`). New exported types:
`CreatePooledEscrowParams`, `ContributeParams`, `ClaimRefundParams`,
`PooledEscrow`, `ContributionRecord`. Contract bindings regenerated.

Additive only: no existing method, type or contract behavior changes, so
single-payer integrations are unaffected. Requires a contract deployment
that includes the pooled entry points; the live testnet deployment
predates them.
