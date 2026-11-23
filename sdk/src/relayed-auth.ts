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

/**
 * Returns true when an auth entry signed for `expiresAtLedger` can no longer
 * be submitted at `currentLedger`. Auth entries are valid through their
 * expiration ledger inclusive, so they expire once the current ledger is
 * strictly greater than `expiresAtLedger`.
 */
export function isRelayedAuthExpired(
  expiresAtLedger: number,
  currentLedger: number,
): boolean {
  return currentLedger > expiresAtLedger;
}

/**
 * Throws a clear error if the auth entry has already expired at the given
 * ledger. Intended to be called before submitting a collected authorization.
 */
export function assertRelayedAuthNotExpired(
  auth: RelayedAuthorization,
  currentLedger: number,
): void {
  if (isRelayedAuthExpired(auth.expiresAtLedger, currentLedger)) {
    throw new Error(
      `Authorization expired at ledger ${auth.expiresAtLedger}; current ledger is ${currentLedger}. ` +
        "Re-prepare the transaction and collect fresh signatures.",
    );
  }
}
