---
"@docforum/escrow-sdk": minor
---

Pooled release deadline and `closeFailedRound` (issue #470; contract issues #288 and #289).

- `createPooledEscrow({ ..., releaseDeadline })` calls `create_pooled_release_deadline`. Without it, the SDK keeps calling `create_pooled_escrow` exactly as before. A `releaseDeadline` that isn't after `fundingDeadline` is rejected offline with the contract's error name, `InvalidReleaseDeadline`.
- `getPooled()` now returns `releaseDeadline` (`undefined` when unset, or on a deployment that predates the field).
- `client.closeFailedRound(escrowId, { source })` → `{ txHash }`: the permissionless call that gives an empty failed round its terminal `Refunded` status.
- New typed `InvalidReleaseDeadlineError` (provisional code 28800).
