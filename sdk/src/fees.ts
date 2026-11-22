import { xdr } from "@stellar/stellar-sdk";
import { type EscrowSigner } from "./signers/types.js";

/** A single contract invocation to estimate the fee of. */
export interface EstimateCallParams {
  /** Contract to invoke. Defaults to the client's configured `contractId`. */
  contractId?: string;
  /** Contract function name, e.g. `"create_escrow"`. */
  method: string;
  /** Already-encoded contract arguments (`xdr.ScVal[]`). */
  args?: xdr.ScVal[];
  /** Account that would sign and pay for the call. */
  source: EscrowSigner;
}

/** Components of a simulated contract call's fee, in stroops. */
export interface FeeEstimate {
  /** Resource fee charged for CPU/memory/ledger entries, buffered for drift. */
  resourceFee: bigint;
  /** Inclusion fee: base fee × number of operations. */
  inclusionFee: bigint;
  /** `resourceFee + inclusionFee` — what the call is expected to cost. */
  total: bigint;
  /** The unbuffered resource fee the simulation reported. */
  minResourceFee: bigint;
}

/** Options for {@link EscrowClient.feeBump}: the fee cap and the wrapper's per-operation base fee. */
export interface FeeBumpOptions {
  /**
   * Hard cap, in stroops, on the fee-bump transaction's fee. If the fee the
   * bump requires would exceed it, `feeBump` throws `MaxFeeExceededError`
   * instead of silently exceeding the cap.
   */
  maxFee: bigint;
  /** Base fee per operation for the wrapper, in stroops. Default: the network base fee (100). */
  baseFee?: bigint;
}

/** The result of {@link EscrowClient.feeBump}: the signed wrapper, its fee, and the inner tx hash. */
export interface FeeBumpResult {
  /** Signed fee-bump envelope, base64 XDR. */
  xdr: string;
  /** Fee the fee-bump transaction will charge, in stroops. */
  fee: bigint;
  /** Hash of the inner (sponsored) transaction — the one that actually executes. */
  innerTxHash: string;
}

/** Outcome of the sponsorship guard. */
export interface GuardResult {
  /** True only when every operation and contract-address auth entry targets the escrow contract. */
  ok: boolean;
  /** Human-readable rejection reasons, empty when `ok`. */
  reasons: string[];
  /** Every contract id the transaction invokes. */
  invokedContracts: string[];
}

/** Thrown when the sponsorship guard rejects a transaction. */
export class SponsorshipGuardError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`Sponsorship guard rejected transaction: ${reasons.join("; ")}`);
    this.name = "SponsorshipGuardError";
    this.reasons = reasons;
  }
}

/** Thrown when a fee-bump would exceed the caller's `maxFee`. */
export class MaxFeeExceededError extends Error {
  readonly requestedFee: bigint;
  readonly maxFee: bigint;
  constructor(requestedFee: bigint, maxFee: bigint) {
    super(`Fee-bump requires ${requestedFee} stroops, above the maxFee cap of ${maxFee}`);
    this.name = "MaxFeeExceededError";
    this.requestedFee = requestedFee;
    this.maxFee = maxFee;
  }
}

/** Default headroom added to the simulated resource fee: 20% (2000 bps). */
export const DEFAULT_RESOURCE_FEE_BUFFER_BPS = 2_000;

/**
 * Pure fee arithmetic, split out so it can be unit-tested without an RPC.
 * The buffer is applied to the resource fee only (inclusion fee is already
 * deterministic) and rounds up, so an estimate is never a strop short.
 */
export function computeFeeEstimate(input: {
  minResourceFee: bigint;
  inclusionFee: bigint;
  bufferBps?: number;
}): FeeEstimate {
  const { minResourceFee, inclusionFee } = input;
  const bufferBps = input.bufferBps ?? DEFAULT_RESOURCE_FEE_BUFFER_BPS;
  if (minResourceFee < 0n) throw new RangeError("minResourceFee must not be negative.");
  if (inclusionFee < 0n) throw new RangeError("inclusionFee must not be negative.");
  if (!Number.isInteger(bufferBps) || bufferBps < 0) throw new RangeError("bufferBps must be a non-negative integer.");
  const resourceFee = (minResourceFee * BigInt(10_000 + bufferBps) + 9_999n) / 10_000n;
  return { resourceFee, inclusionFee, total: resourceFee + inclusionFee, minResourceFee };
}
