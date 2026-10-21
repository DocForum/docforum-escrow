# ADR 0008: Deterministic Isolated Escrow Instances

**Status:** Accepted for Phase E5 implementation; testnet deployment remains
out of scope until the Phase E4 security-review gate is complete.

## Context

The original escrow contract holds every escrow created against one contract
address. Separate integrators need independent storage and token balances so
that a token interaction or contract-level defect in one integration cannot
directly spend another instance's funds.

## Decision

`EscrowFactory` pins one escrow WASM hash in its constructor. An integrator
authorizes one deployment request; the factory derives a salt from a
domain-separated XDR encoding of that integrator, deploys the pinned code, and
stores the resulting address in an on-chain registry. The child constructor
stores the integrator address only as discovery metadata. It does not grant
the integrator a new privileged role and the factory has no method to call,
administer, or upgrade children.

An integrator may be registered once. Repeating a deployment request returns
the typed `AlreadyDeployed` error; the registry is never silently overwritten.
`predict_instance` returns the deterministic child address before deployment,
and `get_instance` returns `None` until the record exists.

## Consequences and limits

- Each child has independent contract storage and token balance accounting.
- The registry is scoped to one factory address; different factories may pin
  different escrow WASM hashes and derive independent child addresses.
- The child integrator field is informational, not authorization. Existing
  escrow authorization remains per escrow through `releaser` and `payer`.
- This is code-hash pinning, not an upgrade mechanism. A new implementation
  requires a new factory deployment; existing instances remain on their
  original WASM.
- A malicious or incompatible WASM hash supplied at factory deployment can
  produce unusable instances. The factory deployer is responsible for
  verifying the uploaded hash before publishing the factory address.
- Factory state and escrow deployments remain testnet-only until the
  independent Phase E4 security review is complete.
