---
"@docforum/escrow-sdk": minor
---

Add isolated escrow factory support (issue #49, `docs/adr/0012`). The escrow
constructor now takes an optional `integrator` address, stored as
informational metadata on each child with no administration path. Contract
bindings regenerated: `EscrowContract` deploy args gain `integrator`
(`Option<Address>`); existing deployments and calls are unaffected.
