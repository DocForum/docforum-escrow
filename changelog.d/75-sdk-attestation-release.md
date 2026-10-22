Issue #75 (Phase E5): attestation-gated release. The contract gains
`release_with_attestation(escrow_id, action, signature)`, which settles a
single-releaser escrow on an ed25519 signature by the releaser's account key
instead of a transaction signed by the releaser, plus the read-only
`attestation_message(escrow_id, action)` view. The signed message is
domain-separated (`docforum-escrow-attestation`) and binds the network id,
contract address, escrow id and action, so a signature cannot be replayed on
another network, deployment, escrow or action.

`InvalidSignature` (25) and `InvalidAction` (26) are appended to `Error`
without renumbering anything. M-of-N escrows keep using
`release_with_approvals`; contract-address releasers have no ed25519 key and
are rejected. The release goes through the same settlement path as `release`,
so `release_not_before`, the acceptance gate, callbacks and the `released`
event all apply unchanged.

The SDK gains `buildAttestationMessage`, `signAttestation` and
`releaseWithAttestation`, mirrored byte for byte with the contract; the fee
payer is a separate `source`, so any funded account can relay an attested
release. `sdk/src/generated/` was regenerated with the pinned Stellar CLI
28.1.0, and `contracts/escrow/tests/attestation.rs` covers the message
layout and every binding (network, contract, escrow id, action).
