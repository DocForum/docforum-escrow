Issue #49 (Phase E5): added a factory contract that pins the escrow WASM hash
and deploys one deterministic, immutable escrow per integrator, with an
integrator-to-instance registry and address prediction. The escrow constructor
takes an optional `integrator` recorded as metadata. See ADR 0012.
