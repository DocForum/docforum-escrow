import { Address, xdr } from "@stellar/stellar-sdk";
import { EscrowError } from "./errors.js";

// ---------------------------------------------------------------------------
// Two-party releaser rotation (issue #326)
//
// `rotate_releaser` needs auth from both the current releaser and the payer,
// usually on different machines. The flow is prepare → sign (each party, its
// own entry only) → submit (by an account that holds neither key).
// ---------------------------------------------------------------------------

/** Default lifetime of rotation auth entries, in ledgers (about an hour). */
export const ROTATION_AUTH_TTL_LEDGERS = 720;

/** Parameters for {@link EscrowClient.prepareRotateReleaser}. */
export interface PrepareRotateReleaserParams {
  escrowId: bigint;
  /** The replacement releaser. Must not be the payee, the contract or the current releaser. */
  newReleaser: string;
  /**
   * The account that will submit (and pay for) the transaction. Use an
   * account that is neither the releaser nor the payer, so the submitter
   * needs neither party's key and both parties sign only auth entries.
   */
  source: string;
  /** How many ledgers the auth entries stay valid. Defaults to {@link ROTATION_AUTH_TTL_LEDGERS}. */
  authValidForLedgers?: number;
}

/**
 * A simulated `rotate_releaser` transaction travelling between the parties.
 * `transaction` is the JSON form produced by `AssembledTransaction.toJSON()`.
 * Pass it to {@link EscrowClient.signRotationAuth} on each signer's machine,
 * then hand every signed copy to {@link EscrowClient.submitRotation}.
 */
export interface RotationAuthorization {
  transaction: string;
  /** Last ledger at which the auth entries are valid (inclusive). */
  expiresAtLedger: number;
  /**
   * Addresses whose auth entry is still unsigned in this copy. Two entries
   * (current releaser and payer) after prepare, or one when the payer is
   * also the releaser.
   */
  pendingSigners: string[];
}

/** Why {@link EscrowClient.prepareRotateReleaser} refused to build a rotation. */
export type RotationPreconditionCode =
  | "NotFunded"
  | "NotSingleReleaser"
  | "NewReleaserIsPayee"
  | "NewReleaserIsContract"
  | "NewReleaserUnchanged";

/** A client-side check failed before the rotation was simulated. */
export class RotationPreconditionError extends EscrowError {
  readonly code: RotationPreconditionCode;
  constructor(code: RotationPreconditionCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The rotation authorization is malformed, signs more than one
 * `rotate_releaser` invocation, is missing a party's signature, or its signed
 * copies do not describe the same transaction.
 */
export class RotationAuthorizationError extends EscrowError {}

/** The `rotate_releaser` auth entries in `entries` addressed to `address`. */
function entriesFor(entries: xdr.SorobanAuthorizationEntry[], address: string): xdr.SorobanAuthorizationEntry[] {
  return entries.filter((entry) => {
    const credentials = entry.credentials();
    if (credentials.switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return false;
    return Address.fromScAddress(credentials.address().address()).toString() === address;
  });
}

/**
 * Checks that every auth entry addressed to `address` authorizes exactly one
 * `rotate_releaser` call on `contractId` and nothing beneath it, so a
 * signature over it cannot be reused for any other invocation. Throws
 * {@link RotationAuthorizationError} otherwise.
 */
export function assertRotationAuthScope(
  entries: xdr.SorobanAuthorizationEntry[],
  contractId: string,
  address: string,
): void {
  const own = entriesFor(entries, address);
  if (own.length === 0) {
    throw new RotationAuthorizationError(`The rotation has no auth entry for ${address}.`);
  }
  for (const entry of own) {
    const invocation = entry.rootInvocation();
    const fn = invocation.function();
    if (fn.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) {
      throw new RotationAuthorizationError(`The auth entry for ${address} is not a contract call.`);
    }
    const args = fn.contractFn();
    const target = Address.fromScAddress(args.contractAddress()).toString();
    const name = args.functionName().toString();
    if (target !== contractId || name !== "rotate_releaser") {
      throw new RotationAuthorizationError(
        `The auth entry for ${address} authorizes ${target}.${name}, not rotate_releaser on ${contractId}.`,
      );
    }
    if (invocation.subInvocations().length > 0) {
      throw new RotationAuthorizationError(
        `The auth entry for ${address} covers sub-invocations beyond rotate_releaser.`,
      );
    }
  }
}

function isSigned(entry: xdr.SorobanAuthorizationEntry): boolean {
  const credentials = entry.credentials();
  if (credentials.switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return true;
  return credentials.address().signature().switch() !== xdr.ScValType.scvVoid();
}

/** The auth entry with its signature (and signature expiration) blanked, for comparing copies. */
function unsignedShape(entry: xdr.SorobanAuthorizationEntry): string {
  const copy = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
  const credentials = copy.credentials();
  if (credentials.switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
    credentials.address().signature(xdr.ScVal.scvVoid());
    credentials.address().signatureExpirationLedger(0);
  }
  return copy.toXDR("base64");
}

function invokeAuth(envelope: xdr.TransactionEnvelope): xdr.SorobanAuthorizationEntry[] {
  if (envelope.switch() !== xdr.EnvelopeType.envelopeTypeTx()) {
    throw new RotationAuthorizationError("A rotation authorization must carry a regular transaction envelope.");
  }
  const operations = envelope.v1().tx().operations();
  if (operations.length !== 1 || operations[0]!.body().switch() !== xdr.OperationType.invokeHostFunction()) {
    throw new RotationAuthorizationError("A rotation authorization must carry exactly one contract invocation.");
  }
  return operations[0]!.body().invokeHostFunctionOp().auth();
}

/** The parsed `transaction` JSON of one rotation authorization (`AssembledTransaction.toJSON()` shape). */
export interface RotationTransactionJson {
  method?: unknown;
  tx?: unknown;
  [key: string]: unknown;
}

/** Parses a rotation authorization's `transaction` and checks it is a `rotate_releaser`. */
export function parseRotationTransaction(authorization: RotationAuthorization): RotationTransactionJson {
  let parsed: RotationTransactionJson;
  try {
    parsed = JSON.parse(authorization.transaction) as RotationTransactionJson;
  } catch (error) {
    throw new RotationAuthorizationError(
      `Rotation authorization is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed.method !== "rotate_releaser") {
    throw new RotationAuthorizationError(
      `Rotation authorization is for ${String(parsed.method ?? "an unknown method")}, not rotate_releaser.`,
    );
  }
  if (typeof parsed.tx !== "string") {
    throw new RotationAuthorizationError("Rotation authorization has no assembled transaction.");
  }
  return parsed;
}

/**
 * Combines independently signed copies of one prepared rotation into a
 * single transaction JSON carrying every party's signed auth entry. Every
 * copy must be the same transaction apart from auth signatures; otherwise
 * {@link RotationAuthorizationError} is thrown. With a single copy, returns
 * its transaction unchanged.
 */
export function mergeRotationAuthorizations(authorizations: RotationAuthorization[]): string {
  if (authorizations.length === 0) {
    throw new RotationAuthorizationError("No rotation authorization to submit.");
  }
  const parsed = authorizations.map(parseRotationTransaction);
  if (parsed.length === 1) return authorizations[0]!.transaction;

  const envelopes = parsed.map((json) => xdr.TransactionEnvelope.fromXDR(json.tx as string, "base64"));
  const base = envelopes[0]!;
  const merged = [...invokeAuth(base)];
  const shapeOf = (env: xdr.TransactionEnvelope): string => {
    const copy = xdr.TransactionEnvelope.fromXDR(env.toXDR());
    const auth = invokeAuth(copy);
    copy.v1().tx().operations()[0]!.body().invokeHostFunctionOp().auth(
      auth.map((entry) => xdr.SorobanAuthorizationEntry.fromXDR(unsignedShape(entry), "base64")),
    );
    copy.v1().signatures([]);
    return copy.toXDR("base64");
  };
  const baseShape = shapeOf(base);
  for (const env of envelopes.slice(1)) {
    if (shapeOf(env) !== baseShape) {
      throw new RotationAuthorizationError("The signed rotation copies are not the same transaction.");
    }
    invokeAuth(env).forEach((entry, i) => {
      if (isSigned(entry) && !isSigned(merged[i]!)) merged[i] = entry;
    });
  }
  base.v1().tx().operations()[0]!.body().invokeHostFunctionOp().auth(merged);
  return JSON.stringify({ ...parsed[0], tx: base.toXDR("base64") });
}
