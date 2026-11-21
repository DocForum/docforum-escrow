// Attestation-based release (issue #42). Pure client-side helpers for
// building and signing an off-chain attestation.
//
// The attester signs a domain-separated message offline with a cold key
// and anyone submits it to `release_with_attestation(escrow_id, signature)`
// on the contract. The message binds the contract, the network and the
// escrow, so an attestation cannot be replayed on another contract, another
// network, or a different escrow. The contract verifies it with
// `env.crypto().ed25519_verify`, which traps the invocation on a bad
// signature, and the escrow settles on release, so an attestation can only
// be used once.
//
// Message layout (all fixed width, no length prefixes to get wrong):
//   "docforum-escrow:release-attestation:v1" || contract id (56-byte strkey)
//   || network id (32 bytes, SHA-256 of the network passphrase) || escrow id
//   (8 bytes, big-endian u64) || "release"
//
// The same layout lives in `contracts/escrow/src/attestation.rs`; keep the
// two in step.

import { hash, Keypair } from "@stellar/stellar-sdk";

/** Domain-separation prefix for release attestations. */
export const ATTESTATION_DOMAIN = "docforum-escrow:release-attestation:v1";

/** The action string for a release attestation. */
export const ATTESTATION_ACTION_RELEASE = "release";

/** Parameters for building a release attestation message. */
export interface ReleaseAttestationParams {
  /** Contract id (56-byte strkey) of the escrow contract. */
  contractId: string;
  /** Network passphrase, e.g. "Test SDF Network ; September 2015". */
  networkPassphrase: string;
  /** Escrow id to release. */
  escrowId: bigint;
}

/** A signed release attestation, ready to submit with `release_with_attestation`. */
export interface SignedReleaseAttestation {
  /** The exact bytes that were signed. */
  message: Buffer;
  /** The 64-byte ed25519 signature over `message`. */
  signature: Buffer;
  /** The attester's public key (the `attester` set at creation). */
  attester: string;
}

/**
 * Builds the exact message an attester signs for a release. No signing
 * happens here; pass the result to `signReleaseAttestation` or sign it
 * with a cold key that never touches this machine.
 */
export function buildReleaseAttestationMessage(
  params: ReleaseAttestationParams,
): Buffer {
  if (params.escrowId < 0n) {
    throw new RangeError("escrowId must be a non-negative integer");
  }
  // The network id is the SHA-256 of the network passphrase, exactly as
  // the contract's `env.ledger().network_id()` reports it.
  const networkId = hash(Buffer.from(params.networkPassphrase, "utf8"));
  const escrowId = Buffer.alloc(8);
  escrowId.writeBigUInt64BE(params.escrowId);
  return Buffer.concat([
    Buffer.from(ATTESTATION_DOMAIN, "utf8"),
    Buffer.from(params.contractId, "utf8"),
    networkId,
    escrowId,
    Buffer.from(ATTESTATION_ACTION_RELEASE, "utf8"),
  ]);
}

/**
 * Signs a release attestation with the attester's keypair and returns the
 * message, signature and attester public key. The signature and the
 * attester go on-chain; the message is only needed off-chain to verify.
 */
export function signReleaseAttestation(
  params: ReleaseAttestationParams & { attester: Keypair },
): SignedReleaseAttestation {
  const message = buildReleaseAttestationMessage(params);
  const signature = params.attester.sign(message);
  return { message, signature, attester: params.attester.publicKey() };
}

/**
 * Checks a signature against a message and an attester public key.
 * Convenience only; the contract does the real check on-chain.
 */
export function verifyReleaseAttestation(params: {
  attester: string;
  message: Buffer;
  signature: Buffer;
}): boolean {
  return Keypair.fromPublicKey(params.attester).verify(
    params.message,
    params.signature,
  );
}
