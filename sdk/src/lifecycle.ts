import { type SettlementReason } from "./preflight.js";
import type { EscrowSigner } from "./signers/types.js";

export type { EscrowSigner } from "./signers/types.js";

/** Timeouts and retry budget for the transaction lifecycle. */
export interface TransactionLifecycleOptions {
  /** Timeout for the simulate step, in milliseconds. */
  simulateTimeoutMs?: number;
  /** Timeout for the send step, in milliseconds. */
  sendTimeoutMs?: number;
  /** Timeout for waiting on confirmation, in milliseconds. */
  confirmTimeoutMs?: number;
  /** Maximum TRY_AGAIN_LATER retries before giving up. */
  maxTryAgainLaterAttempts?: number;
}

/** Defaults applied when a lifecycle option is not provided. */
export const DEFAULT_LIFECYCLE_OPTIONS: Required<TransactionLifecycleOptions> = {
  simulateTimeoutMs: 30_000,
  sendTimeoutMs: 30_000,
  confirmTimeoutMs: 120_000,
  maxTryAgainLaterAttempts: 5,
};

/**
 * Callback invoked as soon as the transaction hash is known. Consumers should
 * persist the hash here, before the confirmation wait begins, so a timeout
 * never loses track of a transaction that may already have landed.
 */
export type OnTransactionHash = (hash: string) => void | Promise<void>;

/**
 * Thrown when a transaction does not confirm within its configured timeout.
 * When `hash` is set the transaction may still land; poll `getTransaction`
 * by that hash rather than resubmitting.
 */
export class TransactionTimeoutError extends Error {
  readonly name = "TransactionTimeoutError";
  readonly hash: string | undefined;
  constructor(stage: string, hash?: string) {
    super(`transaction timed out during ${stage}${hash ? ` (hash ${hash})` : ""}`);
    this.hash = hash;
  }
}

/** Thrown when the network keeps answering TRY_AGAIN_LATER past the retry budget. */
export class TryAgainLaterExhaustedError extends Error {
  readonly name = "TryAgainLaterExhaustedError";
  constructor(attempts: number) {
    super(`TRY_AGAIN_LATER persisted after ${attempts} attempts`);
  }
}

/** Options shared by the lifecycle amendment methods. */
export interface LifecycleCallOptions {
  /**
   * Read the escrow first and throw `EscrowPreconditionError` when the call
   * would certainly fail (wrong signer, not `Funded`, no acceptance gate,
   * already accepted). Costs one read-only simulation, saves a failed
   * transaction fee. The contract enforces the same rules either way.
   * Default `true`.
   */
  checkPreconditions?: boolean;
}

export interface TopUpParams extends LifecycleCallOptions {
  escrowId: bigint;
  /** The escrow's original payer; signs the transfer and pays the fee. */
  payer: EscrowSigner;
  /** Raw token units to add; must be positive. */
  amount: bigint;
}

export interface AcceptParams extends LifecycleCallOptions {
  escrowId: bigint;
  /** The escrow's payee; signs the acceptance and pays the fee. */
  payee: EscrowSigner;
}

export interface TransferPayeeParams extends LifecycleCallOptions {
  escrowId: bigint;
  /** The escrow's current payee; signs the transfer and pays the fee. */
  currentPayee: EscrowSigner;
  /** The address future payouts go to. Must not be the payer or the contract id. */
  newPayee: string;
}

/**
 * Why a lifecycle call was refused before submission. Each maps to the
 * contract error the transaction would otherwise fail with.
 */
export type EscrowPreconditionCode =
  | "InvalidAmount"
  | "NotFunded"
  | "Unauthorized"
  | "InvalidNewPayee"
  | "AcceptanceNotConfigured"
  | "AlreadyAccepted"
  | SettlementReason;

/**
 * A call a client-side precondition check can refuse: a lifecycle amendment,
 * or a settlement (`release`/`refund`, issue #332).
 */
export type PreconditionMethod = LifecycleMethod | "release" | "refund";

/** Thrown before any transaction is built when a client-side check fails. */
export class EscrowPreconditionError extends Error {
  readonly name = "EscrowPreconditionError";
  readonly code: EscrowPreconditionCode;
  readonly method: PreconditionMethod;
  constructor(method: PreconditionMethod, code: EscrowPreconditionCode, message: string) {
    super(`${method}: ${message}`);
    this.method = method;
    this.code = code;
  }
}

/** Contract functions the prepare/submit flow can carry. */
export type LifecycleMethod = "top_up" | "accept" | "cancel" | "transfer_payee";

/** One lifecycle call, described without any signer. */
export type LifecycleCall =
  | { method: "top_up"; escrowId: bigint; payer: string; amount: bigint }
  | { method: "accept"; escrowId: bigint; payee: string }
  | { method: "cancel"; escrowId: bigint; payer: string }
  | { method: "transfer_payee"; escrowId: bigint; currentPayee: string; newPayee: string };

/**
 * A simulated lifecycle transaction in transit between signers. Plain JSON
 * strings and numbers only, so it can be passed between processes or
 * machines as-is (for example over HTTP or a queue).
 */
export interface PreparedLifecycleCall {
  method: LifecycleMethod;
  /** `AssembledTransaction.toJSON()` output; not a base64 envelope. */
  transaction: string;
  /** The transaction source: signs the envelope and pays the fee at submit. */
  source: string;
  /** Addresses whose contract auth entry is still unsigned. */
  pendingSigners: string[];
  /** Ledger after which every collected auth entry expires. */
  expiresAtLedger: number;
}

export interface PrepareLifecycleParams extends LifecycleCallOptions {
  call: LifecycleCall;
  /**
   * Address that will submit the transaction (envelope signer and fee
   * payer). Its own auth is covered by the envelope signature, so it never
   * appears in `pendingSigners`. Defaults to the call's own signer.
   */
  source?: string;
  /** How long collected auth entries stay valid. Default `PREPARED_AUTH_TTL_LEDGERS`. */
  ttlLedgers?: number;
}

/** Default lifetime of auth entries collected by `prepareLifecycleCall`, in ledgers (~5 minutes). */
export const PREPARED_AUTH_TTL_LEDGERS = 60;
