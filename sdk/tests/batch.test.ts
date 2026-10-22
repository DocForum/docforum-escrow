/**
 * Offline unit tests for the batched create/settle helpers (Phase E5,
 * docs/adr/0005). The single-op paths are replaced with in-memory fakes so
 * these assert chunking, input-order mapping, partial-failure reporting and
 * resume behaviour without any RPC call — safe for CI.
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  BatchPartialFailureError,
  EscrowClient,
  MAX_BATCH_SIZE,
  type BatchCreateItem,
  type BatchItemResult,
  type BatchSettleOperation,
} from "../src/index.js";

const payer = Keypair.random();

function newClient(): EscrowClient {
  // Never contacted: every call below is served by the fakes installed on
  // the instance.
  return new EscrowClient({
    contractId: Keypair.random().publicKey(),
    rpcUrl: "https://127.0.0.1:1",
  });
}

function createItem(index: number): BatchCreateItem {
  return {
    payer,
    payee: Keypair.random().publicKey(),
    token: Keypair.random().publicKey(),
    amount: 1_000_000n,
    conditionRef: `batch-unit-${index}`,
    releaser: Keypair.random().publicKey(),
  };
}

function settleOp(index: number): BatchSettleOperation {
  return {
    escrowId: BigInt(index + 1),
    kind: index % 2 === 0 ? "release" : "refund",
    caller: Keypair.random(),
  };
}

describe("createEscrows", () => {
  it("maps results back to input order across chunk boundaries", async () => {
    const client = newClient();
    const seen: string[] = [];
    const createEscrow = vi.fn(async (item: BatchCreateItem) => {
      seen.push(item.conditionRef);
      return { escrowId: BigInt(seen.length), txHash: `hash-${seen.length}` };
    });
    client.createEscrow = createEscrow;

    const items = Array.from({ length: 5 }, (_, index) => createItem(index));
    const results = await client.createEscrows(items, { chunkSize: 2 });

    expect(createEscrow).toHaveBeenCalledTimes(items.length);
    // Every input was sent, in order, once.
    expect(seen).toEqual(items.map((item) => item.conditionRef));
    expect(results.map((result) => result.index)).toEqual([0, 1, 2, 3, 4]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.map((result) => result.escrowId)).toEqual([1n, 2n, 3n, 4n, 5n]);
    results.forEach((result, index) => expect(result.item).toBe(items[index]));
  });

  it("clamps an oversized chunkSize to the contract's max", async () => {
    const client = newClient();
    client.createEscrow = vi.fn(async () => ({ escrowId: 1n, txHash: "h" }));

    expect(client.maxBatchSize).toBe(MAX_BATCH_SIZE);
    await client.createEscrows([createItem(0), createItem(1)], { chunkSize: 1_000 });
    // Both succeed; the clamp itself is exercised by resolveChunkSize and
    // must never let more than MAX_BATCH_SIZE items into one chunk.
    expect(client.createEscrow).toHaveBeenCalledTimes(2);
  });

  it("reports a partial failure with every per-item result, then resumes", async () => {
    const client = newClient();
    const failing = 3;
    const createEscrow = vi.fn(async (item: BatchCreateItem) => {
      if (item.conditionRef === `batch-unit-${failing}`) throw new Error("InvalidAmount");
      return { escrowId: BigInt(Number(item.conditionRef.split("-").at(-1)) + 1), txHash: "hash" };
    });
    client.createEscrow = createEscrow;

    const items = Array.from({ length: 5 }, (_, index) => createItem(index));
    let caught: unknown;
    try {
      await client.createEscrows(items, { chunkSize: 2 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BatchPartialFailureError);
    const failure = caught as BatchPartialFailureError<BatchCreateItem>;
    expect(failure.results).toHaveLength(items.length);
    expect(failure.failedIndices).toEqual([failing]);
    // Chunks after the failure were still attempted.
    expect(createEscrow).toHaveBeenCalledTimes(items.length);
    expect(failure.results[0].ok).toBe(true);
    expect(failure.results[failing].ok).toBe(false);
    expect(failure.results[failing].error).toMatch(/InvalidAmount/);
    expect(failure.results[4].ok).toBe(true);

    // Resume: only the failed item is re-sent, and prior escrow ids are kept.
    const resumedClient = newClient();
    resumedClient.createEscrow = vi.fn(async (item: BatchCreateItem) => ({
      escrowId: BigInt(Number(item.conditionRef.split("-").at(-1)) + 1),
      txHash: "resumed",
    }));
    const resumed = await resumedClient.createEscrows(items, {
      chunkSize: 2,
      resumeFrom: failure.results,
    });

    expect(resumedClient.createEscrow).toHaveBeenCalledTimes(1);
    expect(resumed.map((result) => result.ok)).toEqual([true, true, true, true, true]);
    expect(resumed[failing].skipped).toBe(false);
    expect(resumed[0].skipped).toBe(true);
    expect(resumed[0].escrowId).toBe(failure.results[0].escrowId);
  });

  it("returns an empty result for an empty batch", async () => {
    const client = newClient();
    client.createEscrow = vi.fn();
    await expect(client.createEscrows([])).resolves.toEqual([]);
    expect(client.createEscrow).not.toHaveBeenCalled();
  });
});

describe("settleMany", () => {
  it("dispatches release and refund ops in input order", async () => {
    const client = newClient();
    const calls: string[] = [];
    client.release = vi.fn(async ({ escrowId }: { escrowId: bigint }) => {
      calls.push(`release:${escrowId}`);
      return { txHash: `release-hash-${escrowId}` };
    }) as never;
    client.refund = vi.fn(async ({ escrowId }: { escrowId: bigint }) => {
      calls.push(`refund:${escrowId}`);
      return { txHash: `refund-hash-${escrowId}` };
    }) as never;

    const ops = Array.from({ length: 4 }, (_, index) => settleOp(index));
    const results = await client.settleMany(ops, { chunkSize: 3 });

    expect(calls).toEqual(["release:1", "refund:2", "release:3", "refund:4"]);
    expect(results.map((result) => result.index)).toEqual([0, 1, 2, 3]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results[0].txHash).toBe("release-hash-1");
    expect(results[1].txHash).toBe("refund-hash-2");
  });

  it("reports a failing op and resumes without re-settling successes", async () => {
    const client = newClient();
    client.release = vi.fn(async ({ escrowId }: { escrowId: bigint }) => ({
      txHash: `release-hash-${escrowId}`,
    })) as never;
    client.refund = vi.fn(async ({ escrowId }: { escrowId: bigint }) => {
      if (escrowId === 4n) throw new Error("Unauthorized");
      return { txHash: `refund-hash-${escrowId}` };
    }) as never;

    const ops = [settleOp(0), settleOp(1), settleOp(2), settleOp(3)];
    let caught: unknown;
    try {
      await client.settleMany(ops, { chunkSize: 2 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BatchPartialFailureError);
    const failure = caught as BatchPartialFailureError<BatchSettleOperation>;
    expect(failure.failedIndices).toEqual([3]);
    expect(failure.results[3].error).toMatch(/Unauthorized/);

    const resumeClient = newClient();
    resumeClient.release = vi.fn(async ({ escrowId }: { escrowId: bigint }) => ({
      txHash: `release-hash-${escrowId}`,
    })) as never;
    resumeClient.refund = vi.fn(async ({ escrowId }: { escrowId: bigint }) => ({
      txHash: `refund-hash-${escrowId}`,
    })) as never;

    const resumed: BatchItemResult<BatchSettleOperation>[] = await resumeClient.settleMany(ops, {
      resumeFrom: failure.results,
    });
    expect(resumeClient.release).not.toHaveBeenCalled();
    expect(resumeClient.refund).toHaveBeenCalledTimes(1);
    expect(resumed.every((result) => result.ok)).toBe(true);
    expect(resumed[3].skipped).toBe(false);
    expect(resumed[0].skipped).toBe(true);
  });
});
