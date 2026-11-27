Target: `README.md` (Pooled escrows / SDK helpers)

- `client.getPooledPhase(escrowId)` / `pooledPhase(escrow, pooled, ledgerTime)`: combines `getEscrow`, `getPooled`, and the latest ledger close time (`getLedgerTime`) to return `{ phase, remaining, deadline }` where `phase` is `"open" | "funded" | "failed" | "released"`, matching the contract's `>=` deadline boundary.
