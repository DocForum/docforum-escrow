import { Buffer } from "buffer";

/** Small RPC lifecycle abstraction kept separate so timeout/retry behavior can
 * be exercised with a scripted fake RPC without a live testnet. */
export interface LifecycleRpc {
  sendTransaction(transaction: any): Promise<{ status: string; hash?: string }>;
  getTransaction(hash: string): Promise<{ status: string; returnValue?: unknown }>;
}

export interface LifecycleTransaction<T> {
  sign(): Promise<void>;
  signed?: { hash(): Uint8Array };
  options: { parseResultXdr(value: any): T };
}

export interface LifecycleOptions {
  sendTimeoutMs: number;
  confirmTimeoutMs: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  onTransactionHash?: (hash: string) => void | Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export class TransactionLifecycleTimeoutError extends Error {
  constructor(message: string, readonly txHash?: string) {
    super(message);
    this.name = "TransactionLifecycleTimeoutError";
  }
}

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new TransactionLifecycleTimeoutError(`${phase} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer!));
}

/**
 * Sign once, expose the deterministic transaction hash before network I/O,
 * and only retry a send after the RPC explicitly says TRY_AGAIN_LATER.
 * Confirmation always polls the original hash; it never creates a new tx.
 */
export async function sendWithLifecycle<T>(
  transaction: LifecycleTransaction<T>,
  rpc: LifecycleRpc,
  options: LifecycleOptions,
): Promise<{ txHash: string; result: T }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  await transaction.sign();
  if (!transaction.signed) throw new Error("Transaction signing completed without a signed envelope");

  const txHash = Buffer.from(transaction.signed.hash()).toString("hex");
  await options.onTransactionHash?.(txHash);

  const sendDeadline = now() + options.sendTimeoutMs;
  let backoff = options.initialBackoffMs;
  let sendTimedOut = false;
  while (now() < sendDeadline) {
    let response: { status: string; hash?: string };
    try {
      response = await withTimeout(
        rpc.sendTransaction(transaction.signed),
        Math.max(1, sendDeadline - now()),
        "Transaction send",
      );
    } catch (error) {
      // A transport error is ambiguous: the RPC may have accepted the
      // envelope before the connection failed. Do not issue another send;
      // check the known hash during confirmation instead.
      sendTimedOut = true;
      break;
    }
    if (response.status === "TRY_AGAIN_LATER") {
      const delay = Math.min(backoff, options.maxBackoffMs, Math.max(0, sendDeadline - now()));
      if (delay > 0) await sleep(delay);
      backoff = Math.min(Math.max(1, backoff * 2), options.maxBackoffMs);
      continue;
    }
    // PENDING means accepted. DUPLICATE is safe to inspect by this hash;
    // all other RPC statuses are definitive rejections.
    if (response.status === "PENDING" || response.status === "DUPLICATE") break;
    throw new Error(`RPC rejected transaction submission (${response.status})`);
  }

  const confirmDeadline = now() + options.confirmTimeoutMs;
  backoff = options.initialBackoffMs;
  while (now() < confirmDeadline) {
    let response: { status: string; returnValue?: unknown } | undefined;
    try {
      response = await withTimeout(
        rpc.getTransaction(txHash),
        Math.max(1, confirmDeadline - now()),
        "Transaction confirmation",
      );
    } catch (error) {
      // Confirmation reads are safe to retry: a transient RPC failure says
      // nothing about whether the transaction landed.
    }
    if (response?.status === "SUCCESS") {
      if (response.returnValue === undefined) throw new Error("Confirmed transaction did not include a return value");
      return { txHash, result: transaction.options.parseResultXdr(response.returnValue) };
    }
    if (response?.status === "FAILED") throw new Error(`Transaction ${txHash} failed on chain`);
    // NOT_FOUND can mean the send timed out after acceptance. Keep checking
    // this exact hash rather than submitting another escrow operation.
    const delay = Math.min(backoff, options.maxBackoffMs, Math.max(0, confirmDeadline - now()));
    if (delay > 0) await sleep(delay);
    backoff = Math.min(Math.max(1, backoff * 2), options.maxBackoffMs);
  }

  const reason = sendTimedOut ? "send timed out and confirmation was not observed" : "confirmation timed out";
  throw new TransactionLifecycleTimeoutError(`Transaction ${txHash}: ${reason}`, txHash);
}
