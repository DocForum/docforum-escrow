Issue #338: added pooled-escrow hooks to `@docforum/escrow-react`.
`usePooledEscrow(id)` reads `getEscrow` and `getPooled` together and derives
an `open` / `funded` / `failed` / `released` phase from the contract's
boundary rules; because a failed round stays `Funded` on-chain, polling stops
on the phase (`failed` or `released`), not the status. `useContribution(id,
address)` reads one contributor's record. `useEscrowActions` gained
`contribute(escrowId, amount)` and `claimRefund(escrowId)`, which invalidate
both queries. New stable keys: `escrowKeys.pooled`, `escrowKeys.contribution`,
`escrowKeys.contributions`.
