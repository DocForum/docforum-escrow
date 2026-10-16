# ADR 0007: Optional off-chain attestation for release

**Status:** Accepted

## Context

An escrow's releaser currently needs to submit the release transaction from
an online, funded account. Integrators that keep authorization keys offline
need a way to authorize release without trusting the transaction submitter.

## Decision

At creation, a payer may set an optional Ed25519 `attester` public key. If
present, anyone may submit `release_with_attestation` with the attester's
signature over the contract's `release_attestation_payload`. The payload is
the SHA-256 digest of the XDR encoding of a versioned domain string, the
current contract address, the current network id, escrow id, and the
`release` action. The contract id and network id prevent cross-contract and
cross-network replay; the escrow id and action prevent reuse for another
escrow or operation. Funded status allows a signature to settle only once.

This path does not replace the existing releaser authorization. Escrows
without an `attester` continue to use `release`, and all escrows retain the
same refund rules. A signed attestation authorizes release only; it cannot
refund funds or change escrow data.

## Consequences

- `create_escrow` gains an optional argument and `EscrowData` gains an
  optional field. Existing deployed Wasm and generated bindings are not
  compatible; deploy a new contract and release SDK 0.4.0 before consumers
  adopt the signature.
- The configured attester key is public on chain. The signer should keep its
  secret key offline and sign only the payload returned for the intended
  escrow and network.
- Anyone can relay a valid signature and pay the transaction fee.
- Ed25519 verification adds Soroban CPU and ledger resource costs; record
  these from a reproducible testnet simulation before production use.
- The independent security review in Phase E4 remains required before any
  mainnet deployment.

## References

- Issue [#42](https://github.com/DocForum/docforum-escrow/issues/42)
