---
file: README.md
after: "await client.claimRefund({ escrowId, contributor: bob });   // 350_000 back to bob"
---

// Optional release deadline (issue #288): after it, contributors can claimRefund even from a fully
// funded pool that was never released, so a lost releaser key can't lock it. Must be after fundingDeadline.
const { escrowId: guarded } = await client.createPooledEscrow({ ...poolParams, releaseDeadline: 1_760_086_400n });
(await client.getPooled(guarded)).releaseDeadline; // 1_760_086_400n, or undefined if unset

// A failed round nobody contributed to: anyone may give it its terminal Refunded status (issue #289).
// A round with contributions returns RefundNotOpen here; it closes on its last claimRefund instead.
await client.closeFailedRound(escrowId, { source: anyone });
