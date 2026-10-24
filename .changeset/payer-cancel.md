---
"@docforum/escrow-sdk": minor
---

Add payer `cancel` before the payee accepts (issue #27, `docs/adr/0010`).
New `client.cancel({ escrowId, payer })`; `EscrowStatus` gains `"Cancelled"`.
Only valid for escrows created with the acceptance gate, while `Funded` and not
yet accepted; funds go to the escrow's `refundTo`.

Breaking for code that exhaustively matches `EscrowStatus`. Requires a contract
deployment that includes `cancel`; the live testnet deployment predates it.
