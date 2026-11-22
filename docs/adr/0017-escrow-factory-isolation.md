# ADR 0017: Isolated escrow instances

The escrow factory deploys a separate escrow contract for each integrator.
The factory receives a WASM hash once at construction, derives a salt from the
integrator address and requested salt, and passes the integrator's immutable
constructor configuration to the new instance. It stores only the registry
entry and does not retain an admin capability, so later escrow operations are
authorized by the instance itself.
