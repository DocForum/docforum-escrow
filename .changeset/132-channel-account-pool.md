---
"@docforum/escrow-sdk": minor
---

Add `ChannelAccountPool` (issue #132): exclusive checkout of funded source accounts so concurrent submissions do not reuse a sequence number. `acquire()`/`release()`/`run()` plus `failFast`, FIFO waiters, `close()`, and 8 offline tests. Additive only; no contract change.
