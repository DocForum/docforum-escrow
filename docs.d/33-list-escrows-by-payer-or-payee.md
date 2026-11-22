---
file: ROADMAP.md
section: Phase E5 — Contract features
---
- [x] List escrows by payer or payee (issue #33, ADR 0015): decided **off-chain**, so the contract is unchanged. The `ESCROW` event (issue #9) already carries `payer`/`payee`, and the issue #87 indexer already stores them, so the query is an index filter; `EscrowIndexerClient.listEscrows` gained optional `payer`/`payee` filters. No redeploy; SDK minor, additive.
