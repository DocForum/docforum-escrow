---
file: ARCHITECTURE_ESSENTIALS.md
section: React hooks (issue #126)
---
- `useEscrowActions(signer)` also wraps `accept`, `cancel`, `topUp`,
  `contribute` and `claimRefund`; a client-side `EscrowPreconditionError`
  resolves as `{ status: "precondition", error }` (issues #337, #338).
- `usePooledEscrow(id)` reads `getEscrow` + `getPooled` and derives the
  funding phase (`open` / `funded` / `failed` / `released`), polling until the
  phase settles rather than until the status changes — a failed round stays
  `Funded` on-chain. `useContribution(id, address)` reads one contributor's
  record. `contribute` / `claimRefund` invalidate both queries (issue #338).
- `useEscrowEvents({ escrowId?, types?, cursor? })` owns a
  `client.subscribe` lifecycle, keeps a bounded event list, exposes the latest
  cursor, invalidates the escrow queries named in received events, and
  surfaces `EventCursorExpiredError` as state (issue #339).
