import { describe, expect, it, vi } from "vitest";
import { sendWithLifecycle, TransactionLifecycleTimeoutError, withTimeout, type LifecycleRpc } from "../src/transaction-lifecycle.js";

function fakeTransaction() {
  return {
    sign: vi.fn(async () => undefined),
    signed: { hash: () => Uint8Array.from([0xab, 0xcd]) },
    options: { parseResultXdr: (value: unknown) => value },
  };
}

function options(overrides: Partial<Parameters<typeof sendWithLifecycle>[2]> = {}) {
  return {
    sendTimeoutMs: 30,
    confirmTimeoutMs: 30,
    initialBackoffMs: 1,
    maxBackoffMs: 2,
    sleep: async () => undefined,
    ...overrides,
  };
}

describe("transaction lifecycle", () => {
  it("returns a confirmed result and exposes the hash before submission", async () => {
    const tx = fakeTransaction();
    const order: string[] = [];
    const rpc: LifecycleRpc = {
      sendTransaction: vi.fn(async () => { order.push("send"); return { status: "PENDING" }; }),
      getTransaction: vi.fn(async () => ({ status: "SUCCESS", returnValue: 42 })),
    };

    const result = await sendWithLifecycle(tx, rpc, options({ onTransactionHash: (hash) => order.push(`hash:${hash}`) }));

    expect(result).toEqual({ txHash: "abcd", result: 42 });
    expect(order).toEqual(["hash:abcd", "send"]);
  });

  it("backs off on TRY_AGAIN_LATER and resends the same signed envelope", async () => {
    const tx = fakeTransaction();
    const sent: unknown[] = [];
    const rpc: LifecycleRpc = {
      sendTransaction: vi.fn(async (envelope) => {
        sent.push(envelope);
        return { status: sent.length === 1 ? "TRY_AGAIN_LATER" : "PENDING" };
      }),
      getTransaction: vi.fn(async () => ({ status: "SUCCESS", returnValue: "ok" })),
    };
    const sleep = vi.fn(async () => undefined);

    await sendWithLifecycle(tx, rpc, options({ sleep }));

    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("polls the known hash after a send timeout without resubmitting", async () => {
    const tx = fakeTransaction();
    const rpc: LifecycleRpc = {
      sendTransaction: vi.fn(() => new Promise(() => undefined)),
      getTransaction: vi.fn(async () => ({ status: "SUCCESS", returnValue: "landed" })),
    };

    const result = await sendWithLifecycle(tx, rpc, options({ sendTimeoutMs: 2 }));

    expect(result.txHash).toBe("abcd");
    expect(rpc.sendTransaction).toHaveBeenCalledOnce();
    expect(rpc.getTransaction).toHaveBeenCalledWith("abcd");
  });

  it("polls after an ambiguous send transport error instead of resubmitting", async () => {
    const rpc: LifecycleRpc = {
      sendTransaction: vi.fn(async () => { throw new Error("connection reset after write"); }),
      getTransaction: vi.fn(async () => ({ status: "SUCCESS", returnValue: "landed" })),
    };

    await expect(sendWithLifecycle(fakeTransaction(), rpc, options())).resolves.toMatchObject({ txHash: "abcd" });
    expect(rpc.sendTransaction).toHaveBeenCalledOnce();
    expect(rpc.getTransaction).toHaveBeenCalledWith("abcd");
  });

  it("returns a hash-bearing error if confirmation remains NOT_FOUND", async () => {
    const rpc: LifecycleRpc = {
      sendTransaction: vi.fn(async () => ({ status: "PENDING" })),
      getTransaction: vi.fn(async () => ({ status: "NOT_FOUND" })),
    };

    await expect(sendWithLifecycle(fakeTransaction(), rpc, options({ confirmTimeoutMs: 3 })))
      .rejects.toMatchObject({ name: "TransactionLifecycleTimeoutError", txHash: "abcd" });
  });

  it("times out a stalled simulation stage", async () => {
    await expect(withTimeout(new Promise(() => undefined), 2, "Transaction simulation"))
      .rejects.toBeInstanceOf(TransactionLifecycleTimeoutError);
  });

  it("surfaces an on-chain failed transaction without retrying it", async () => {
    const rpc: LifecycleRpc = {
      sendTransaction: vi.fn(async () => ({ status: "PENDING" })),
      getTransaction: vi.fn(async () => ({ status: "FAILED" })),
    };

    await expect(sendWithLifecycle(fakeTransaction(), rpc, options())).rejects.toThrow("failed on chain");
    expect(rpc.sendTransaction).toHaveBeenCalledOnce();
  });
});
