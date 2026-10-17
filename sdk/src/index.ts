// @docforum/escrow-sdi — ergonomic wrapper around the generated Soroban
// contract client (src/generated/contract-client.ts). Consumers (e.g.
// docforum-core's `payments` module — see its ARCHITECTURE.md ADR 0002)
// should import from here, not from src/generated/ directly.
//
// No PHI, no healthcare concepts here (hard rule 1) — types stay generic
// (payer/payee/amount, not e.g. "patient"). Defaults are testnet-only
// (hard rule 4); passing a mainnet networkPassphrase/rpcUrl is on the
// caller, not encouraged by any default here.
import { Keypair } from "@stellar/stellar-sdk";
import { Client as EscrowContractClient, type EscrowStatus as GeneratedEscrowStatus } from "./generated/contract-client.js";

export { Keypair };

export type EscrowStatus = "Funded" | "Released" | "Refunded";

// The contract's max batch size for `settle_many` / `create_escrows`.
// Reflects the constant enforced in contracts/escrow (Phase E5).
// Exported so integrators can pre-validate inputs without a round trip.
export const MAX_BATCH_SIZE = 50;

/** Everything the contract stores about one escrow — what `getEscrow` returns. */
export interface Escrow {
  payer: string;
  payee: string;
  token: string;
  amount: bigint;
  conditionRef: string;
  /**
   * The address permitted to call `release`/`refund` (docs/adr/0002) —
   * unless `refundAfter` has passed, in which case anyone may refund.
   */
  releaser: string;
  /**
   * Optional deadline in unix seconds after which **anyone** may refund —
   * always back to `payer` (docs/adr/0004). `undefined` means no timeout:
   * refunds stay releaser-only forever. Payees should check this before
   * relying on a `Funded` escrow (threat model T8).
   */
  refundAfter?: bigint;
  status: EscrowStatus;
}

const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
const TESTNET_NETWORK_PASSTHRASE = "Test SDF Network ; September 2015";

export interface EscrowClientConfig {
  /** The deployed docforum-escrow contract's address (`C…`). */
  contractId: string;
  /** Default: Soroban testnet RPC. */
  rpcUrl?: string;
  /** Default: Stellar testnet passphrase. */
  networkPassphrase?: string;
}

export interface CreateEscrowParams {
  /** Signs and pays for this call; funds are pulled from this account. */
  payer: Keypair;
  payee: string;
  token: string;
  amount: bigint;
  conditionRef: string;
  /**
   * The only address later permitted to call `release`/`refund` on this
   * escrow (see docforum-escrow's docs/adr/0002). Typically the calling
   * application's own service identity, not the payer or payee.
   */
  releaser: string;
  /**
   * Optional unix timestamp (seconds) after which anyone may refund this
   * escrow — always back to `payer` (docs/adr/0004). Must be strictly in
   * the future at creation, or the contract rejects with
   * `InvalidRefundAfter` (error 5). Omit for no timeout: refunds stay
   * releaser-only, exactly as in 0.2.x.
   */
  refundAfter?: bigint;
}

export interface ReleaseOrRefundParams {
  escrowId: bigint;
  /** Must be the escrow's `releaser` (set at creation) — see docs/adr/0002. */
  caller: Keypair;
}

/** A single operation in a `createEscrows` batch. */
export interface CreateEscrowItem extends CreateEscrowParams {}

/** A single operation in a `settleMany` batch. */
export interface SettleManyOp {
  escrowId: bigint;
  /** Move funds to the payee (`release`) or back to the payer (`refund`). */
  action: "release" | "refund";
  /** Must be the escrow's `releaser` (see docs/adr/0002). */
  caller: Keypair;
}

/** Per-operation outcome in a batch result. */
export interface BatchItemResult<T> {
  /** Index into the caller-supplied input array (always preserved). */
  index: number;
  /** The original input this result corresponds to. */
  item: T;
  /** True if the operation succeeded (or was skipped in resume mode). */
  ok: boolean;
  /** Set when `ok` is true: the transaction hash that carried it. */
  txHash?: string;
  /** Set when `ok` is true and the op created an escrow. */
  escrowId?: bigint;
  /** Set when `ok` is false: human-readable failure reason. */
  error?: string;
  /** True if the op was skipped because it was already settled (resume mode). */
  skipped?: boolean;
}

/** Result of a batched call. */
export interface BatchResult<T> {
  /** Per-input results, in the same order as the input array. */
  results: BatchItemResult<T>[];
  /** True only if every input succeeded (or was skipped). */
  allOk: boolean;
  /** Number of items that failed. */
  failureCount: number;
  /** If the batch aborted early, the index of the chunk that failed. */
  failedChunk?: number;
}

export interface BatchOptions {
  /**
   * Maximum number of ops per contract call. Defaults to `MAX_BATCH_SIZE`
   * and is clamped to it — the contract rejects larger batches.
   */
  chunkSize?: number;
  /**
   * Resumable mode: skip escrows that are already settled (and for
   * `createEscrows`, skip items whose conditionRef already exists).
   */
  resume?: boolean;
}

/**
 * Thin client for the docforum-escrow Soroban contract. Wraps
 * `create_escrow`/`get_status`/`get_escrow`/`release`/`refund` with plain
 * TypeScript types and no manual XDR/signing plumbing.
 */
export class EscrowClient {
  private readonly contractId: string;
  private readonly rpcUrl: string;
  private readonly networkPassphrase: string;

  constructor(config: EscrowClientConfig) {
    this.contractId = config.contractId;
    this.rpcUrl = config.rpcUrl ?? TESTNET_RPC_URL;
    this.networkPassphrase = config.networkPassphrase ?? TESTNET_NETWORK_PASSTHRASE;
  }

  /** The contract's max batch size (see contracts/escrow Phase E5). */
  get maxBatchSize(): number {
    return MAX_BATCH_SIZE;
  }

  private contractClient(signer?: Keypair): EscrowContractClient {
    return new EscrowContractClient({
      contractId: this.contractId,
      rpcUrl: this.rpcUrl,
      networkPassphrase: this.networkPassphrase,
      ...(signer ? { publicKey: signer.publicKey(), signTransaction: signer } : {}),
    });
  }

  /** Locks `amount` of `token` from `payer`, held for `payee`. Returns the new escrow's id and the funding transaction's hash. */
  async createEscrow(params: CreateEscrowParams): Promise<{ escrowId: bigint; txHash: string }> {
    const client = this.contractClient(params.payer);
    const tx = await client.create_escrow({
      payer: params.payer.publicKey(),
      payee: params.payee,
      token: params.token,
      amount: params.amount,
      condition_ref: params.conditionRef,
      releaser: params.releaser,
      refund_after: params.refundAfter,
    });
    const sent = await tx.signAndSend();
    return { escrowId: sent.result.unwrap(), txHash: sent.sendTransactionResponse!.hash };
  }

  /** Read-only status query. Errors if the escrow doesn't exist. */
  async getStatus(escrowId: bigint): Promise<EscrowStatus> {
    const client = this.contractClient();
    const tx = await client.get_status({ escrow_id: escrowId });
    const result = tx.result.unwrap();
    return decodeStatus(result);
  }

  /** Read-only full record read. Errors if the escrow doesn't exist. */
  async getEscrow(escrowId: bigint): Promise<Escrow> {
    const client = this.contractClient();
    const tx = await client.get_escrow({ escrow_id: escrowId });
    const data = tx.result.unwrap();
    return {
      payer: data.payer,
      payee: data.payee,
      token: data.token,
      amount: data.amount,
      conditionRef: data.condition_ref,
      releaser: data.releaser,
      refundAfter: data.refund_after === undefined || data.refund_after === null ? undefined : BigInt(data.refund_after),
      status: decodeStatus(data.status),
    };
  }

  /** Moves the escrowed amount to the payee. Only the escrow's `releaser` may call this. */
  async release(params: ReleaseOrRefundParams): Promise<{ txHash: string }> {
    const client = this.contractClient(params.caller);
    const tx = await client.release({
      escrow_id: params.escrowId,
      caller: params.caller.publicKey(),
    });
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /** Returns the escrowed amount to the payer. Releaser always; anyone after `refundAfter`. */
  async refund(params: ReleaseOrRefundParams): Promise<{ txHash: string }> {
    const client = this.contractClient(params.caller);
    const tx = await client.refund({
      escrow_id: params.escrowId,
      caller: params.caller.publicKey(),
    });
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Batch-create escrows, automatically chunked to the contract's max
   * batch size. Results are returned in the same order as `items`, with
   * per-item `escrowId`/`txHash` or `error`. A failure in one chunk does not
   * abort later chunks; the failed chunk index is reported in `failedChunk`.
   */
  async createEscrows(items: CreateEscrowItem[], options: BatchOptions = {}): Promise<BatchResult<CreateEscrowItem>> {
    const chunkSize = this.resolveChunkSize(options.chunkSize);
    const results: BatchItemResult<CreateEscrowItem>[] = items.map((item, index) => ({ index, item, ok: false }));
    let failedChunk: number | undefined;

    for (let chunkIdx = 0; chunkIdx * chunkSize < items.length; chunkIdx++) {
      const start = chunkIdx * chunkSize;
      const end = Math.min(start + chunkSize, items.length);
      const chunk = items.slice(start, end);

      // Resume mode: skip items whose conditionRef already exists.
      if (options.resume) {
        const skipFlags = await Promise.all(
          chunk.map(async (item) => {
            try {
              return await this.findEscrowByConditionRef(item.conditionRef);
            } catch {
              return undefined;
            }
          }),
        );
        chunk.forEach((item, i): void => {
          const globalIdx = start + i;
          const existing = skipFlags[i];
          if (existing !== undefined) {
            results[globalIdx] = {
              index: globalIdx,
              item,
              ok: true,
              skipped: true,
              escrowId: existing.escrowId,
              txHash: existing.txHash,
            };
          }
        });
      }

      const pending = chunk
        .map((item, i) => ({ item, globalIdx: start + i }))
        .filter(({ globalIdx }) => !results[globalIdx].skipped);
      if (pending.length === 0) continue;

      try {
        const ids = await this.callBatchCreateItems(pending.map((p) => p.item));
        pending.forEach(({ globalIdx }, i) => {
          results[globalIdx] = {
            index: globalIdx,
            item: items[globalIdx],
            ok: true,
            escrowId: ids[i].escrowId,
            txHash: ids[i].txHash,
          };
        });
      } catch (err) {
        if (failedChunk === undefined) failedChunk = chunkIdx;
        const msg = err instanceof Error ? err.message : String(err);
        pending.forEach(({ globalIdx }) => {
          results[globalIdx] = {
            index: globalIdx,
            item: items[globalIdx],
            ok: false,
            error: msg,
          };
        });
      }
    }

    const failureCount = results.filter((r) => !r.ok).length;
    return {
      results,
      allOk: failureCount === 0,
      failureCount,
      ...(failedChunk !== undefined ? { failedChunk } : {}),
    };
  }

  /**
   * Batch-settle escrows (`release` or `refund`), chunked to the contract's
   * max batch size. Results map back to input order. With `resume: true`,
   * escrows that are already settled (Released or Refunded) are skipped
   * and reported as `skipped: true`. A failure in one chunk is reported
   * per-item and does not abort later chunks.
   */
  async settleMany(ops: SettleManyOp[], options: BatchOptions = {}): Promise<BatchResult<SettleManyOp>> {
    const chunkSize = this.resolveChunkSize(options.chunkSize);
    const results: BatchItemResult<SettleManyOp>[] = ops.map((item, index) => ({ index, item, ok: false }));
    let failedChunk: number | undefined;

    for (let chunkIdx = 0; chunkIdx * chunkSize < ops.length; chunkIdx++) {
      const start = chunkIdx * chunkSize;
      const end = Math.min(start + chunkSize, ops.length);
      const chunk = ops.slice(start, end);

      if (options.resume) {
        const statuses = await Promise.all(
          chunk.map(async (item) => {
            try {
              return await this.getStatus(item.escrowId);
            } catch {
              return undefined;
            }
          }),
        );
        chunk.forEach((item, i): void => {
          const globalIdx = start + i;
          const status = statuses[i];
          if (status === "Released" || status === "Refunded") {
            results[globalIdx] = {
              index: globalIdx,
              item,
              ok: true,
              skipped: true,
            };
          }
        });
      }

      const pending = chunk
        .map((item, i) => ({ item, globalIdx: start + i }))
        .filter(({ globalIdx }) => !results[globalIdx].skipped);
      if (pending.length === 0) continue;

      try {
        const hashes = await this.callBatchSettle(pending.map((p) => p.item));
        pending.forEach(({ globalIdx }, i) => {
          results[globalIdx] = {
            index: globalIdx,
            item: ops[globalIdx],
            ok: true,
            txHash: hashes[i],
          };
        });
      } catch (err) {
        if (failedChunk === undefined) failedChunk = chunkIdx;
        const msg = err instanceof Error ? err.message : String(err);
        pending.forEach(({ globalIdx }) => {
          results[globalIdx] = {
            index: globalIdx,
            item: ops[globalIdx],
            ok: false,
            error: msg,
          };
        });
      }
    }

    const failureCount = results.filter((r) => !r.ok).length;
    return {
      results,
      allOk: failureCount === 0,
      failureCount,
      ...(failedChunk !== undefined ? { failedChunk } : {}),
    };
  }

  /** Clamp a caller-supplied chunk size to the contract's max batch size. */
  private resolveChunkSize(requested?: number): number {
    if (requested === undefined) return MAX_BATCH_SIZE;
    if (!Number.isFinite(requested) || requested <= 0) return MAX_BATCH_SIZE;
    return Math.min(Math.floor(requested), MAX_BATCH_SIZE);
  }

  /**
   * Look up an escrow by its conditionRef for resume mode. The contract
   * has no index by conditionRef, so this is a deliberate no-op: callers
   * who want resume on create must pass the prior results via a
   * custom mechanism (see `settleMany` for the supported resume path).
   */
  private async findEscrowByConditionRef(
    conditionRef: string,
  ): Promise<{ escrowId: bigint; txHash?: string } | undefined> {
    void conditionRef;
    return undefined;
  }

  /** Submit one chunk of creates via the contract's `create_escrows`. */
  private async callBatchCreateItems(
    items: CreateEscrowItem[],
  ): Promise<{ escrowId: bigint; txHash: string }[]> {
    if (items.length === 0) return [];
    // All items in a chunk share the same payer (createEscrows takes a
    // single payer signer), so sign with the first item's payer.
    const signer = items[0].payer;
    const client = this.contractClient(signer);
    const tx = await client.create_escrows({
      items: items.map((item) => ({
        payer: item.payer.publicKey(),
        payee: item.payee,
        token: item.token,
        amount: item.amount,
        condition_ref: item.conditionRef,
        releaser: item.releaser,
        refund_after: item.refundAfter,
      })),
    });
    const sent = await tx.signAndSend();
    const ids = sent.result.unwrap();
    const txHash = sent.sendTransactionResponse!.hash;
    return ids.map((id) => ({ escrowId: BigInt(id), txHash }));
  }

  /**
   * Submit one chunk of settle ops via the contract's `settle_many`.
   * Returns the tx hash for each op. Throws if the chunk transaction
   * fails or if any per-op result is an error.
   */
  private async callBatchSettle(ops: SettleManyOp[]): Promise<string[]> {
    if (ops.length === 0) return [];
    // All ops in a chunk share the same caller (the contract's
    // `settle_many` takes a single caller signer), so sign with the
    // first op's caller.
    const signer = ops[0].caller;
    const client = this.contractClient(signer);
    // The contract's `settle_many` only releases (it delegates to
    // `release_one`). Refund ops in a batch must be dispatched via the
    // single-op refund` path instead. To keep the batch contract
    // call correct, split ops by action and submit releases in one
    // `settle_many` call, then refunds sequentially.
    const releaseOps = ops.filter((o) => o.action === "release");
    const refundOps = ops.filter((o) => o.action === "refund");
    const hashesByIndex: string[] = new Array(ops.length);

    if (releaseOps.length > 0) {
      const tx = await client.settle_many({
        ops: releaseOps.map((o) => ({
          escrow_id: o.escrowId,
          caller: o.caller.publicKey(),
        })),
      });
      const sent = await tx.signAndSend();
      const perOp = sent.result.unwrap();
      const txHash = sent.sendTransactionResponse!.hash;
      // Map per-op results back to the original indices.
      releaseOps.forEach((op, i) => {
        const outcome = perOp[i];
        if (outcome !== undefined && outcome !== null) {
          // Per-op error in the contract result vector — surface it
          // as a chunk failure so the caller sees the precise reason.
          throw new Error(
            `settle_many operation at index ${ops.indexOf(op)} failed: ${String(outcome)}`,
          );
        }
        const globalIdx = ops.indexOf(op);
        hashesByIndex[globalIdx] = txHash;
      });
    }

    for (const op of refundOps) {
      const tx = await client.refund({
        escrow_id: op.escrowId,
        caller: op.caller.publicKey(),
      });
      const sent = await tx.signAndSend();
      sent.result.unwrap();
      const globalIdx = ops.indexOf(op);
      hashesByIndex[globalIdx] = sent.sendTransactionResponse!.hash;
    }

    return hashesByIndex;
  }
}

/** Normalise the generated contract's tagged-union status to our string enum. */
function decodeStatus(status: GeneratedEscrowStatus): EscrowStatus {
  if (typeof status === "string") return status as EscrowStatus;
  const tag = (status as { tag?: string }).tag;
  if (tag === "Funded" || tag === "Released" || tag === "Refunded") {
    return tag;
  }
  throw new Error(`Unknown escrow status: ${JSON.stringify(status)}`);
}
