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

  it("isolates a failing payee callback to its own release transaction", async () => {
    // Issue #367: each op is its own transaction, so a payee callback that
    // fails after the payout cannot revert the other releases.
    const client = newClient();
    const calls: bigint[] = [];
    client.release = vi.fn(async ({ escrowId }: { escrowId: bigint }) => {
      calls.push(escrowId);
      if (escrowId === 2n) throw new Error("CallbackFailed");
      return { txHash: `release-hash-${escrowId}` };
    }) as never;

    const ops: BatchSettleOperation[] = [1n, 2n, 3n].map((escrowId) => ({
      escrowId,
      kind: "release",
      caller: Keypair.random(),
    }));
    let caught: unknown;
    try {
      await client.settleMany(ops);
    } catch (error) {
      caught = error;
    }

    // One transaction per op, including the one that hit the callback.
    expect(calls).toEqual([1n, 2n, 3n]);
    const failure = caught as BatchPartialFailureError<BatchSettleOperation>;
    expect(failure).toBeInstanceOf(BatchPartialFailureError);
    expect(failure.failedIndices).toEqual([1]);
    expect(failure.results.map((result) => result.ok)).toEqual([true, false, true]);
    expect(failure.results[1].error).toMatch(/CallbackFailed/);

    // Resuming re-sends only the callback's escrow, never the settled ones.
    const resumedClient = newClient();
    resumedClient.release = vi.fn(async ({ escrowId }: { escrowId: bigint }) => ({
      txHash: `release-hash-${escrowId}`,
    })) as never;
    const resumed = await resumedClient.settleMany(ops, { resumeFrom: failure.results });
    expect(resumedClient.release).toHaveBeenCalledTimes(1);
    expect(resumed.every((result) => result.ok)).toBe(true);
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

describe("on-chain batch mode (issue #328)", () => {
  it("createEscrows(mode: 'onchain') sends ceil(n/chunkSize) transactions and preserves input order", async () => {
    const client = newClient();
    let nextId = 100n;
    let txSeq = 0;
    const create_escrows = vi.fn(async ({ items }: { items: unknown[] }) => {
      txSeq += 1;
      const hash = `batch-create-tx-${txSeq}`;
      const ids = items.map(() => nextId++);
      return {
        signAndSend: async () => ({ sendTransactionResponse: { hash } }),
        result: { unwrap: () => ids },
      };
    });
    const createEscrow = vi.fn(async (item: BatchCreateItem) => ({
      escrowId: 999n,
      txHash: `single-${item.conditionRef}`,
    }));
    Object.assign(client, {
      ensureNetworkVerified: vi.fn(async () => {}),
      contractClient: () => ({ create_escrows }),
      createEscrow,
    });

    const items = [
      createItem(0),
      { ...createItem(1), feeBps: 50, feeRecipient: Keypair.random().publicKey() }, // fallback
      createItem(2),
      createItem(3),
    ];

    const results = await client.createEscrows(items, { mode: "onchain", chunkSize: 2 });
    // 3 expressible items with chunkSize 2 -> ceil(3/2) = 2 create_escrows calls, plus 1 fallback.
    expect(create_escrows).toHaveBeenCalledTimes(2);
    expect(createEscrow).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    expect(results.map((r) => r.escrowId)).toEqual([100n, 999n, 101n, 102n]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("settleMany(mode: 'onchain') chunks by MAX_SETTLE_OPS (12), groups by caller, and maps outcomes", async () => {
    const client = newClient();
    const callerA = Keypair.random();
    const callerB = Keypair.random();
    let txSeq = 0;
    const settle_many = vi.fn(async ({ ops }: { ops: Array<readonly [bigint, unknown]> }) => {
      txSeq += 1;
      const hash = `batch-settle-tx-${txSeq}`;
      return {
        signAndSend: async () => ({ sendTransactionResponse: { hash } }),
        result: {
          unwrap: () =>
            ops.map(([id]) =>
              id === 2n
                ? { isOk: () => false, unwrapErr: () => new Error("AlreadySettled") }
                : { isOk: () => true, unwrapErr: () => undefined },
            ),
        },
      };
    });
    Object.assign(client, {
      ensureNetworkVerified: vi.fn(async () => {}),
      contractClient: () => ({ settle_many }),
    });

    // 13 ops for callerA (chunks into 12 + 1) + 1 op for callerB = 3 transactions.
    const ops: BatchSettleOperation[] = [
      ...Array.from({ length: 13 }, (_, i) => ({
        escrowId: BigInt(i + 1),
        kind: (i % 2 === 0 ? "release" : "refund") as "release" | "refund",
        caller: callerA,
      })),
      { escrowId: 100n, kind: "release", caller: callerB },
    ];

    let caught: unknown;
    try {
      await client.settleMany(ops, { mode: "onchain", chunkSize: 16 });
    } catch (error) {
      caught = error;
    }
    expect(settle_many).toHaveBeenCalledTimes(3);
    expect(caught).toBeInstanceOf(BatchPartialFailureError);
    const failure = caught as BatchPartialFailureError<BatchSettleOperation>;
    expect(failure.failedIndices).toEqual([1]);
    expect(failure.results[1].error).toMatch(/AlreadySettled/);
    expect(failure.results[13].ok).toBe(true);

    // resumeFrom skips the 13 succeeded ops and only sends index 1.
    settle_many.mockClear();
    const resumed = await client.settleMany(
      ops.map((op, i) => (i === 1 ? { ...op, escrowId: 999n } : op)),
      { mode: "onchain", resumeFrom: failure.results },
    );
    expect(settle_many).toHaveBeenCalledTimes(1);
    expect(resumed.every((r) => r.ok)).toBe(true);
    expect(resumed[0].skipped).toBe(true);
    expect(resumed[1].skipped).toBe(false);
  });

  it("settleMany(mode: 'onchain') retries a reverted chunk one op per transaction, so a failing callback only fails its own release", async () => {
    const client = newClient();
    const caller = Keypair.random();
    const settle_many = vi.fn(async () => {
      throw new Error("HostError: callback reverted");
    });
    const release = vi.fn(async ({ escrowId }: { escrowId: bigint }) => {
      if (escrowId === 1n) throw new Error("CallbackFailed");
      return { txHash: `single-release-${escrowId}` };
    });
    const refund = vi.fn(async ({ escrowId }: { escrowId: bigint }) => ({ txHash: `single-refund-${escrowId}` }));
    Object.assign(client, {
      ensureNetworkVerified: vi.fn(async () => {}),
      contractClient: () => ({ settle_many }),
      release,
      refund,
    });

    const ops: BatchSettleOperation[] = [
      { escrowId: 1n, kind: "release", caller },
      { escrowId: 2n, kind: "release", caller },
      { escrowId: 3n, kind: "refund", caller },
    ];

    let caught: unknown;
    try {
      await client.settleMany(ops, { mode: "onchain" });
    } catch (error) {
      caught = error;
    }
    expect(settle_many).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(caught).toBeInstanceOf(BatchPartialFailureError);
    const failure = caught as BatchPartialFailureError<BatchSettleOperation>;
    expect(failure.failedIndices).toEqual([0]);
    expect(failure.results[0].error).toMatch(/CallbackFailed/);
    expect(failure.results[1]).toMatchObject({ ok: true, txHash: "single-release-2" });
    expect(failure.results[2]).toMatchObject({ ok: true, txHash: "single-refund-3" });
  });
});
