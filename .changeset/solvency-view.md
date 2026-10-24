---
"@docforum/escrow-sdk": minor
---

Add `client.getSolvency(token)` (issue #39), returning `{ balance,
liabilities, solvent }` for one token: the escrow contract's balance next
to the on-chain total it owes across every `Funded` escrow in that token.
New exported type `SolvencyReport`. Contract bindings regenerated.

Additive only. Requires a contract deployment that includes `solvency`;
the live testnet deployment predates it.
