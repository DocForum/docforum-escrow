---
"@docforum/escrow-sdk": minor
---

Accept escrow contract 3.x (`SUPPORTED_CONTRACT_VERSIONS.maxExclusive` is now
`4.0.0`). Contract 3.0.0 reclaims a settled escrow's record (issue #48,
docs/adr/0013): `getEscrow` now throws for a settled id, so read settled
escrows with `getStatus` and history from the `ESCROW` state events.
