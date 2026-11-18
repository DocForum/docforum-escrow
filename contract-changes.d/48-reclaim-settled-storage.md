bump: major
---
Issue #48: reclaim storage for settled escrows (docs/adr/0013). Settling a non-pooled escrow removes its full `EscrowData` record and keeps only the `Status` entry (whose TTL is extended as before); `get_escrow` on a settled id now returns `NotFound` and mutating calls return `NotFunded`. Pooled escrows keep their full record. Breaking for callers that read `get_escrow` after settlement; the SDK supported-version range must be widened when this is folded.
