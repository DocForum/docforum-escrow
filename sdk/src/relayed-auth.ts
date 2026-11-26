import { Keypair } from "@stellar/stellar-sdk";

/** The relayer pays the transaction fee; the releaser signs only contract auth. */
export interface RelayedAuthorizationParams {
  escrowId: bigint;
  releaser: Keypair;
  relayer: Keypair;
}

/**
 * Serialized, simulated transaction containing a short-lived signed auth
 * entry. `transaction` is the JSON form produced by the Stellar SDK's
 * `AssembledTransaction.toJSON()` (it carries the simulation metadata the
 * relayer needs to sign the envelope); it is not a base64 envelope.
 */
export interface RelayedAuthorization {
  transaction: string;
  expiresAtLedger: number;
}

/** How long a relayed auth entry stays valid, in ledgers. */
export const RELAYED_AUTH_TTL_LEDGERS = 10;

// ---------------------------------------------------------------------------
// Prepare / sign / submit (issue #58)
// ---------------------------------------------------------------------------
