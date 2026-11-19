bump: patch
---
No behaviour or interface change: `contracts/escrow/src/lib.rs` is split into
one module per area (`create.rs`, `pooled.rs`, `release_refund.rs`, `errors.rs`,
…) so contract PRs stop editing the same file. The contract spec is
entry-for-entry identical; only the WASM's internal function and spec-entry
order changes, so the WASM hash differs from 3.0.0.
