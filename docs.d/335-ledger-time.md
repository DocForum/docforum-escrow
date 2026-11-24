---
file: ARCHITECTURE_ESSENTIALS.md
after: "await client.getTokenInfo(token);           // { decimals, symbol, name } — cached token metadata read from the SEP-41 contract"
---
client.getLedgerTime();                       // { closeTime, sequence, offsetMs } — latest ledger close time, cached ~5 s (issue #335)
await client.ledgerClockOffset();             // ledger time − local time in ms, for useEscrowTimeline({ ledgerTimeOffsetMs })
