// Prepare / sign / submit helpers (issues #58 and #59).
//
// Pure, network-free building blocks for splitting "build + simulate" from
// "sign" from "submit": the payer or releaser can sign somewhere else (a
// browser wallet, an air-gapped machine, a multisig ceremony) and any process
// can submit the result. Everything here works on base64 XDR envelopes.
import { Address, Keypair, Transaction, TransactionBuilder, authorizeEntry, xdr } from "@stellar/stellar-sdk";

/** An unsigned, simulated transaction ready to be signed elsewhere. */
export interface PreparedTransaction {
  /** Unsigned transaction envelope, base64 XDR. */
  xdr: string;
  /** Hex transaction hash. Pass it back as `expectedHash` to `submitSigned`. */
  hash: string;
  /**
   * The last ledger the transaction is valid in (enforced by the network via
   * ledger bounds). After it, submission fails with
   * `PreparedTransactionExpiredError`.
   */
  validUntilLedger: number;
  /** Source account: pays the fee and supplies the sequence number. */
  source: string;
  /**
   * Addresses OTHER than `source` that must sign Soroban auth entries
   * (`EscrowClient.signAuthEntries`) before the envelope is signed. Empty when
   * the source account's envelope signature authorizes everything, which is
   * the case whenever the source is also the payer / releaser.
   */
  authSigners: string[];
  /** Suggested expiration ledger for those auth-entry signatures. */
  authValidUntilLedger: number;
}

/** The prepared transaction's ledger window has passed; prepare a new one. */
export class PreparedTransactionExpiredError extends Error {
  constructor(
    readonly validUntilLedger: number,
    readonly currentLedger: number,
  ) {
    super(
      `The prepared transaction expired at ledger ${validUntilLedger} ` +
        `(current ledger ${currentLedger}). Prepare a new one and sign it again.`,
    );
    this.name = "PreparedTransactionExpiredError";
  }
}

/** The signed envelope is not the transaction that was prepared. */
export class SignedTransactionMismatchError extends Error {
  constructor(
    readonly expectedHash: string,
    readonly actualHash: string,
  ) {
    super(
      `Signed transaction hash ${actualHash} does not match the prepared hash ` +
        `${expectedHash}; the signer returned a different transaction.`,
    );
    this.name = "SignedTransactionMismatchError";
  }
}

/**
 * The source account's sequence number moved after the transaction was built,
 * so the network would reject it as `tx_bad_seq`. Prepare it again.
 */
export class StaleSequenceError extends Error {
  constructor(
    readonly source: string,
    readonly expectedSequence: bigint,
    readonly onChainSequence: bigint,
  ) {
    super(
      `Source account ${source} is at sequence ${onChainSequence}, but the transaction ` +
        `expects ${expectedSequence}. Another transaction from this account landed ` +
        `after it was prepared; prepare and sign a new one.`,
    );
    this.name = "StaleSequenceError";
  }
}

/** The envelope carries no signature at all. */
export class UnsignedTransactionError extends Error {
  constructor() {
    super("The transaction has no signatures; sign it before submitting.");
    this.name = "UnsignedTransactionError";
  }
}

/** Hex transaction hash of a (non fee-bump) envelope. */
export function transactionHash(envelopeXdr: string, networkPassphrase: string): string {
  return TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase).hash().toString("hex");
}

/**
 * Returns the envelope with its preconditions replaced by a ledger window
 * (`maxLedger`, no time bound). Edits the XDR in place rather than rebuilding
 * the transaction: `TransactionBuilder.cloneFrom` drops the Soroban resource
 * data, which would make the network reject the result.
 */
export function setLedgerBounds(envelopeXdr: string, maxLedger: number): string {
  const envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, "base64");
  if (envelope.switch().name !== "envelopeTypeTx") {
    throw new TypeError("Expected a regular transaction envelope.");
  }
  envelope.v1().tx().cond(
    xdr.Preconditions.precondV2(
      new xdr.PreconditionsV2({
        timeBounds: null,
        ledgerBounds: new xdr.LedgerBounds({ minLedger: 0, maxLedger }),
        minSeqNum: null,
        minSeqAge: xdr.Uint64.fromString("0"),
        minSeqLedgerGap: 0,
        extraSigners: [],
      }),
    ),
  );
  return envelope.toXDR("base64");
}

/** The transaction's `maxLedger`, or undefined when it has no ledger bound. */
export function ledgerBoundsMax(tx: Transaction): number | undefined {
  const max = tx.ledgerBounds?.maxLedger;
  return max !== undefined && max > 0 ? max : undefined;
}

/** Soroban auth entries that still need an address signature. */
function unsignedAddressEntries(tx: Transaction): xdr.SorobanAuthorizationEntry[] {
  const entries: xdr.SorobanAuthorizationEntry[] = [];
  for (const operation of tx.operations) {
    if (operation.type !== "invokeHostFunction") continue;
    for (const entry of operation.auth ?? []) {
      const credentials = entry.credentials();
      if (
        credentials.switch().name === "sorobanCredentialsAddress" &&
        credentials.address().signature().switch().name === "scvVoid"
      ) {
        entries.push(entry);
      }
    }
  }
  return entries;
}

/** Addresses that still have to sign an auth entry of this transaction. */
export function authSignersOf(tx: Transaction): string[] {
  const addresses = unsignedAddressEntries(tx).map((entry) =>
    Address.fromScAddress(entry.credentials().address().address()).toString(),
  );
  return [...new Set(addresses)];
}

/** Identity of one signature, for de-duplication when merging. */
function signatureKey(signature: xdr.DecoratedSignature): string {
  return `${signature.hint().toString("hex")}:${signature.signature().toString("hex")}`;
}

/**
 * Merges the signatures of several signed copies of the SAME transaction into
 * one envelope, for a classic multisig account whose signers sign separately
 * (often on different machines). Every input must hash identically, so a
 * signer cannot slip in a different transaction; duplicate signatures are
 * dropped and the first occurrence's order is kept. The network, not this
 * function, decides whether the merged signatures meet the account's
 * threshold.
 */
export function mergeSignatures(signedXdrs: string[], networkPassphrase: string): string {
  if (signedXdrs.length === 0) throw new RangeError("mergeSignatures needs at least one signed transaction.");

  const transactions = signedXdrs.map((envelopeXdr, index) => {
    const tx = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
    if (!(tx instanceof Transaction)) {
      throw new TypeError(`Input ${index} is a fee-bump envelope; merge the inner transactions instead.`);
    }
    return tx;
  });

  const expected = transactions[0]!.hash().toString("hex");
  transactions.forEach((tx) => {
    const actual = tx.hash().toString("hex");
    if (actual !== expected) throw new SignedTransactionMismatchError(expected, actual);
  });

  const merged = TransactionBuilder.fromXDR(signedXdrs[0]!, networkPassphrase) as Transaction;
  const seen = new Set(merged.signatures.map(signatureKey));
  for (const tx of transactions.slice(1)) {
    for (const signature of tx.signatures) {
      const key = signatureKey(signature);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.signatures.push(signature);
    }
  }
  return merged.toXDR();
}

/**
 * Signs, as `signer`, every still-unsigned Soroban auth entry addressed to it,
 * valid until `validUntilLedger`, and returns the updated envelope and its new
 * hash. Needed when the transaction source is not the signer (for example a
 * hot fee-paying account with a cold releaser). Auth entries are part of what
 * the envelope signature covers, so this must run BEFORE the envelope is
 * signed; an already signed envelope is rejected rather than silently
 * invalidated.
 */
export async function signAuthEntriesInEnvelope(
  envelopeXdr: string,
  signer: Keypair,
  validUntilLedger: number,
  networkPassphrase: string,
): Promise<{ xdr: string; hash: string; signedEntries: number }> {
  const tx = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
  if (!(tx instanceof Transaction)) throw new TypeError("Expected a regular transaction envelope.");
  if (tx.signatures.length > 0) {
    throw new Error(
      "The envelope is already signed; signing an auth entry would invalidate those signatures. " +
        "Sign auth entries first, then the envelope.",
    );
  }

  const envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, "base64");
  let signedEntries = 0;
  for (const operation of envelope.v1().tx().operations()) {
    const body = operation.body();
    if (body.switch().name !== "invokeHostFunction") continue;
    const auth = body.invokeHostFunctionOp().auth();
    for (let index = 0; index < auth.length; index += 1) {
      const credentials = auth[index]!.credentials();
      if (
        credentials.switch().name !== "sorobanCredentialsAddress" ||
        credentials.address().signature().switch().name !== "scvVoid" ||
        Address.fromScAddress(credentials.address().address()).toString() !== signer.publicKey()
      ) {
        continue;
      }
      auth[index] = await authorizeEntry(auth[index]!, signer, validUntilLedger, networkPassphrase);
      signedEntries += 1;
    }
  }
  if (signedEntries === 0) {
    throw new Error(`The transaction has no unsigned auth entry for ${signer.publicKey()}.`);
  }
  const updated = envelope.toXDR("base64");
  return { xdr: updated, hash: transactionHash(updated, networkPassphrase), signedEntries };
}
