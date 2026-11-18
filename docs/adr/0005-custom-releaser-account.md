# ADR 0005: M-of-N custom releaser account

**Status:** Accepted for implementation (issue #50). Not deployed to testnet.

## Context

The escrow's per-deal `releaser` can be a single key or a Stellar account
with classic multisig. Classic multisig provides a signer threshold, but
does not constrain which contract calls that threshold authorizes. The
releaser controls outcomes for every escrow assigned to it, so compromise
of a quorum must not grant arbitrary contract-call authority.

## Decision

Add `contracts/releaser-account/`, a Soroban custom account configured at
construction with one escrow contract, an Ed25519 public-key set, and a
threshold `M`. The target escrow address is immutable. `__check_auth`
verifies distinct registered signatures over Soroban's host-generated
authorization payload, then permits exactly one `release` or `refund`
context on that target. Soroban's authorization payload binds signatures
to the transaction nonce and call context, preventing reuse for another
transaction or operation. Additional and nested contexts are rejected.

Signer additions/removals and threshold changes are signed management
actions. Their digest binds a domain tag, this account address, the current
management nonce, and the full action. The nonce increments only after a
successful update. Every change is verified against the current signer set
and threshold, and a removal cannot leave fewer keys than the threshold.

The account accepts up to 20 distinct signers to bound verification work.
Use its address as the escrow's `releaser`. It cannot redirect funds or
change the escrow's destinations. It can still choose a wrong release or
refund, so quorum coordination and signer security remain critical.

## Consequences

- A lost or compromised single signer is insufficient when `M > 1`.
- A compromised quorum can only choose `release` or `refund` on the
  configured escrow; it cannot call unrelated functions with this account.
- Signers must sign the public `management_payload(action)` digest before
  submitting `manage(action, signatures)`; stale digests fail after any
  successful management operation.
- The custom account is a new contract that requires its own deployment,
  operational runbook, independent review, and testnet verification before
  real use. This ADR does not authorize mainnet deployment.
- Existing escrow contract signatures and deployed escrow instances do not
  change.

## Alternatives considered

1. **Classic Stellar multisig:** simpler and already enforced by
   `require_auth`, but does not restrict the call policy to this escrow's
   release/refund methods.
2. **Single releaser key in a KMS:** improves key handling but leaves one
   key with full outcome authority.
3. **Releaser management inside the escrow contract:** rejected because it
   would add mutable privileged state and expand the deployed contract's
   authority surface.
