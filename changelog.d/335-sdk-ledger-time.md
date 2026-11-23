Issue #335 (Phase E6): added `client.getLedgerTime()` and
`client.ledgerClockOffset()` to the SDK. Every contract deadline
(`refund_after`, `release_not_before`, `funding_deadline`) is compared against
the ledger close time, so the helper reads the latest ledger through RPC,
derives `closeTime × 1000 − local time`, and caches the reading for
`DEFAULT_LEDGER_TIME_CACHE_MS` (5 s) with concurrent reads coalesced; a fresh
read is one `{ maxAgeMs: 0 }` away, and the cache never serves a value older
than the documented window. `useEscrowTimeline` can now be fed
`ledgerClockOffset()` instead of a hand-computed offset. The offset is advisory
and ledger close time lags real time; the contract stays the authority. No
contract change, so the generated bindings are unchanged.
