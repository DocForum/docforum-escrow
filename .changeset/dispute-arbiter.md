---
"@docforum/escrow-sdk": minor
---

Add dispute and arbiter support with split settlement (issue #73,
`docs/adr/0009`). `createEscrow` accepts an optional `arbiter`, and escrows
created with one expose:

- `raiseDispute({ escrowId, caller })` — payer, payee or any releaser, while
  `Funded`; moves the escrow to the new `Disputed` status.
- `resolveDispute({ escrowId, caller, payerBps, payeeBps })` — arbiter-only,
  once; the basis points must sum to 10_000 and move no funds.
- `settle({ escrowId, signer })` — permissionless; pays both sides from the
  recorded split with no dust and marks the escrow `Released`.
- `getEscrow()` now returns `splitBps?: { payerBps, payeeBps }` and
  `availableActions(escrow, address, ledgerTime)` reports the calls an address
  may make at that ledger time.

`release`/`refund` (and the approval variants) are rejected while an escrow is
`Disputed`. The new contract errors are 25–28, appended after the codes already
published on testnet. Requires a contract deployment that includes the dispute
surface; the live testnet deployment predates it.
