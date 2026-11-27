import { type FeeBumpTransaction, type Transaction } from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import {
  RequestTimeoutError,
  TransactionFailedError,
  TransactionPendingError,
  TryAgainLaterExhaustedError,
} from "./errors.js";
import {
  DEFAULT_LIFECYCLE_OPTIONS,
  type OnTransactionHash,
  type TransactionLifecycleOptions,
} from "./lifecycle.js";

/** The RPC calls the lifecycle needs; a scripted fake satisfies it in tests. */
export interface LifecycleRpc {
  sendTransaction(tx: Transaction | FeeBumpTransaction): Promise<Api.SendTransactionResponse>;
  pollTransaction(hash: string, opts: { attempts: number }): Promise<Api.GetTransactionResponse>;
  getTransaction(hash: string): Promise<Api.GetTransactionResponse>;
}

/** Merges per-field overrides over the defaults. */
export function resolveLifecycleOptions(
  ...layers: (TransactionLifecycleOptions | undefined)[]
): Required<TransactionLifecycleOptions> {
  const out = { ...DEFAULT_LIFECYCLE_OPTIONS };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer) as [keyof TransactionLifecycleOptions, number | undefined][]) {
      if (value === undefined) continue;
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`transaction.${key} must be a non-negative number, got ${value}.`);
      }
      out[key] = value;
    }
  }
  return out;
}

const TIMED_OUT = Symbol("timed out");

/** Resolves to `TIMED_OUT` instead of rejecting when `ms` passes first. */
function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Rejects with `RequestTimeoutError` when `promise` takes longer than `ms`. */
export async function withStageTimeout<T>(promise: Promise<T>, ms: number, stage: string): Promise<T> {
  const result = await raceTimeout(promise, ms);
  if (result === TIMED_OUT) throw new RequestTimeoutError(`${stage} timed out after ${ms} ms.`);
  return result;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What {@link sendAndConfirm} reports for a confirmed transaction. */
export interface ConfirmedTransaction {
  hash: string;
  response: Api.GetSuccessfulTransactionResponse;
}

/**
 * Sends `tx` and waits for it to land, without ever submitting a different
 * envelope:
 *
 * 1. `onHash` runs with the hash before anything is sent.
 * 2. `TRY_AGAIN_LATER` resends the same envelope with exponential backoff, up
 *    to `maxTryAgainLaterAttempts`, then throws `TryAgainLaterExhaustedError`.
 * 3. A send that times out may still have reached the mempool, so it is never
 *    resent: the SDK moves on to waiting for the hash.
 * 4. Confirmation polls `getTransaction` by hash until `confirmTimeoutMs`. If
 *    the deadline passes, one last lookup by hash decides: success is
 *    reported as success ("timed out but landed"), anything else throws
 *    `TransactionPendingError` carrying the hash to check later.
 *
 * `onError` maps an `ERROR` send response to the caller's error type.
 */
export async function sendAndConfirm(
  rpc: LifecycleRpc,
  tx: Transaction | FeeBumpTransaction,
  options: {
    lifecycle: Required<TransactionLifecycleOptions>;
    pollAttempts: number;
    onHash?: OnTransactionHash;
    onError: (sent: Api.SendTransactionResponse) => Promise<never> | never;
  },
): Promise<ConfirmedTransaction> {
  const { lifecycle, pollAttempts } = options;
  const localHash = tx.hash().toString("hex");
  if (options.onHash) await options.onHash(localHash);
  // The RPC echoes the same hash; prefer its copy once it answers.
  let hash = localHash;

  let tryAgainLater = 0;
  let sendTimedOut = false;
  for (;;) {
    const sent = await raceTimeout(rpc.sendTransaction(tx), lifecycle.sendTimeoutMs);
    if (sent === TIMED_OUT) {
      sendTimedOut = true;
      break;
    }
    if (sent.hash) hash = sent.hash;
    if (sent.status === "ERROR") await options.onError(sent);
    if (sent.status === "TRY_AGAIN_LATER") {
      tryAgainLater += 1;
      if (tryAgainLater > lifecycle.maxTryAgainLaterAttempts) {
        throw new TryAgainLaterExhaustedError(hash, tryAgainLater);
      }
      await sleep(lifecycle.tryAgainLaterBackoffMs * 2 ** (tryAgainLater - 1));
      continue;
    }
    // PENDING or DUPLICATE: the network holds this exact envelope.
    break;
  }

  const polled = await raceTimeout(rpc.pollTransaction(hash, { attempts: pollAttempts }), lifecycle.confirmTimeoutMs);
  let final: Api.GetTransactionResponse | undefined = polled === TIMED_OUT ? undefined : polled;
  if (!final || final.status === Api.GetTransactionStatus.NOT_FOUND) {
    // Deadline passed or polls ran out: look the hash up once more instead of resubmitting.
    try {
      final = await rpc.getTransaction(hash);
    } catch {
      final = undefined;
    }
  }
  if (final?.status === Api.GetTransactionStatus.SUCCESS) {
    return { hash, response: final as Api.GetSuccessfulTransactionResponse };
  }
  if (final?.status === Api.GetTransactionStatus.FAILED) {
    throw new TransactionFailedError(hash, `Transaction ${hash} failed on-chain.`);
  }
  const why = polled === TIMED_OUT
    ? `was not confirmed within ${lifecycle.confirmTimeoutMs} ms`
    : `was not confirmed after ${pollAttempts} polls`;
  throw new TransactionPendingError(
    hash,
    `Transaction ${hash} ${sendTimedOut ? "send timed out and " : ""}${why}; ` +
      `it may still land, so check its hash before retrying.`,
  );
}
