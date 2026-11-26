import { type EscrowSigner } from "./signers/types.js";
import { type CreateEscrowParams } from "./escrow-types.js";

/**
 * Maximum number of items in one batched call — must match the contract's
 * `MAX_BATCH_SIZE` (currently 16, see docs/adr/0012). `createEscrows` and
 * `settleMany` chunk larger inputs automatically. Keep in sync with the
 * contract; a change is an SDK semver event (hard rule 3).
 */
export const MAX_BATCH_SIZE = 16;

/**
 * Maximum number of operations in one on-chain `settle_many` call — must
 * match the contract's `MAX_SETTLE_OPS` (currently 12, see docs/adr/0012).
 * `settleMany` in this SDK sends one `release`/`refund` per operation instead,
 * so it chunks by {@link MAX_BATCH_SIZE}; this constant is for callers that
 * build the contract's `settle_many` invocation themselves. Keep in sync with
 * the contract: `scripts/check-sdk-constants.mjs` fails CI on a mismatch.
 */
export const MAX_SETTLE_OPS = 12;

/** One escrow to create in a batched `createEscrows` call. */
export interface BatchCreateItem extends CreateEscrowParams {}

/**
 * One operation in a batched `settleMany` call.
 *
 * `settleMany` sends each operation as its own `release`/`refund`
 * transaction, never as one contract `settle_many` call. That is deliberate:
 * a release callback (`notifyPayee`) runs after the payout, so a payee
 * contract that fails it reverts the whole invocation. Per-op transactions
 * keep such a failure contained — it can only revert its own escrow (issue
 * #367, docs/adr/0012). Refund ops never invoke the callback.
 */
export interface BatchSettleOperation {
  escrowId: bigint;
  /** `release` pays the escrow's payee; `refund` returns the funds to `refundTo`. */
  kind: "release" | "refund";
  /** Must be the escrow's `releaser` (docs/adr/0002). */
  caller: EscrowSigner;
}

/** Outcome of one batched item; `index` is always the input's position. */
export interface BatchItemResult<T> {
  /** Index into the caller-supplied input array. */
  index: number;
  /** The original input this result corresponds to. */
  item: T;
  ok: boolean;
  /** Set when `ok`: the transaction hash that carried the operation. */
  txHash?: string;
  /** Set when `ok` and the operation created an escrow. */
  escrowId?: bigint;
  /** Set when the operation failed: the reason the call threw. */
  error?: string;
  /** True when the item was carried over from `resumeFrom` instead of re-sent. */
  skipped?: boolean;
}

/** Options for the chunked batch helpers (`createEscrows`, `settleMany`). */
export interface BatchOptions<T> {
  /**
   * Operations attempted per chunk. Defaults to `MAX_BATCH_SIZE` and is
   * clamped to it, because the contract rejects anything larger.
   */
  chunkSize?: number;
  /**
   * Results from a previous partial run. Items that already succeeded are
   * carried over (with `skipped: true`) instead of being sent again, so a
   * retry after `BatchPartialFailureError` never double-creates or
   * double-settles anything.
   */
  resumeFrom?: BatchItemResult<T>[];
}

/**
 * Thrown by `createEscrows`/`settleMany` when at least one item failed.
 * `results` covers the whole input in order, so items that were already
 * committed (or settled) before the failure are visible and retryable
 * through `resumeFrom`.
 */
export class BatchPartialFailureError<T> extends Error {
  readonly name = "BatchPartialFailureError";
  readonly results: BatchItemResult<T>[];
  readonly failedIndices: number[];

  constructor(results: BatchItemResult<T>[]) {
    const failedIndices = results.filter((result) => !result.ok).map((result) => result.index);
    super(
      `batch failed for ${failedIndices.length} of ${results.length} item(s) at index ${failedIndices.join(", ")}`,
    );
    this.results = results;
    this.failedIndices = failedIndices;
  }
}
