bump: minor
---
Issue #288: added `create_pooled_release_deadline` entry point with an optional `release_deadline: Option<u64>` and `InvalidReleaseDeadline = 28800`. Fully funded pooled escrows can be refunded by contributors via `claim_refund` once the release deadline passes without release.
