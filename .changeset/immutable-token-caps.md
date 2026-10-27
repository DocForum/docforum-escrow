---
"@docforum/escrow-sdk": minor
---

Expose immutable per-token maximum amounts in the generated escrow constructor
bindings. Cap configuration is fixed at deployment and enforced for ordinary
escrows, pooled funding targets, and payer top-ups (issue #56, ADR 0013).
