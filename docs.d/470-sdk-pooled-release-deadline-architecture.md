---
file: ARCHITECTURE_ESSENTIALS.md
after: "const { escrowId, txHash } = await client.createEscrow({ payer, payee, token, amount, conditionRef, releaser, refundAfter, notifyPayee: true, refundTo, feeRecipient, feeBps });"
---
// Pooled (issue #470): createPooledEscrow({ ..., releaseDeadline }) → create_pooled_release_deadline (omitted: create_pooled_escrow);
// getPooled() → { fundingTarget, fundingDeadline, releaseDeadline? }; closeFailedRound(escrowId, { source }) → { txHash }.
