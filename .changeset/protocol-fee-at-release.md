---
"@docforum/escrow-sdk": minor
---

Issue #30 (Phase E5): optional protocol fee taken at release. `createEscrow`
gains an optional `feeRecipient`/`feeBps` pair (both or neither, `feeBps`
capped at `MAX_FEE_BPS` = 1 000, i.e. 10 %), and `getEscrow` now returns
`feeRecipient`/`feeBps` as declared at creation. The pair is fixed at
creation; `release` pays the floored bps share to `feeRecipient` and the
exact remainder to the payee, and refunds return the full amount with no fee
(ADR 0010).
