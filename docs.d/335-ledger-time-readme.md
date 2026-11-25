---
file: README.md
section: React hooks
---
### Ledger time for deadlines

`useEscrowTimeline` counts down to `refundAfter`, which the contract compares
to the **ledger** close time, not the local clock. Ask the chain for the
offset instead of passing one by hand:

```tsx
const offsetMs = await escrowClient.ledgerClockOffset(); // ledger time − local time
const { remainingMs, expired } = useEscrowTimeline(escrow, { ledgerTimeOffsetMs: offsetMs });
```

`client.getLedgerTime()` returns the latest ledger's `closeTime`, `sequence`
and that `offsetMs`, cached for a few seconds (`{ maxAgeMs: 0 }` forces a
fresh read). The offset is advisory: ledger close time lags real time — often
by several seconds — and the contract decides whether a deadline has passed.
