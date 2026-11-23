---
file: ARCHITECTURE_ESSENTIALS.md
after: "const { escrowId, txHash } = await client.createEscrow({ payer, payee, token, amount, conditionRef, releaser, refundAfter, notifyPayee: true, refundTo, feeRecipient, feeBps });"
---
// Creation rejects offline with the matching contract error name, before any
// transaction is built: InvalidAmount (2), InvalidRefundTo (21), InvalidFee (35)
// and InvalidReleaseNotBefore (22) when releaseNotBefore is later than refundAfter.
