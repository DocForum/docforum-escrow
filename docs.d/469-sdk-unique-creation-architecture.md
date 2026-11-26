---
file: ARCHITECTURE_ESSENTIALS.md
after: "const { escrowId, txHash } = await client.createEscrow({ payer, payee, token, amount, conditionRef, releaser, refundAfter, notifyPayee: true, refundTo, feeRecipient, feeBps });"
---
// Retry-safe creation (issue #469): createEscrow({ ..., unique: true }) → { escrowId, txHash, existing: false }
// or, on a duplicate (payer, conditionRef), { escrowId, txHash: undefined, existing: true, status }; mismatched terms throw
// UniqueEscrowMismatchError. client.getUniqueEscrow(payer, conditionRef) → bigint | undefined.
