import { describe, expect, it, vi } from "vitest";
import { Account, Keypair, Networks, Operation, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import {
  DEFAULT_LIFECYCLE_OPTIONS,
  RequestTimeoutError,
  TransactionFailedError,
  TransactionPendingError,
  TryAgainLaterExhaustedError,
} from "../src/index.js";
import {
  type LifecycleRpc,
  resolveLifecycleOptions,
  sendAndConfirm,
  withStageTimeout,
} from "../src/transaction-lifecycle.js";

const source = Keypair.random();

function makeTx(): Transaction {
  const tx = new TransactionBuilder(new Account(source.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "10" }))
    .setTimeout(300)
    .build();
  tx.sign(source);
  return tx;
}

const never = <T>() => new Promise<T>(() => {});
const success = { status: Api.GetTransactionStatus.SUCCESS } as Api.GetTransactionResponse;
const notFound = { status: Api.GetTransactionStatus.NOT_FOUND } as Api.GetTransactionResponse;
const failed = { status: Api.GetTransactionStatus.FAILED } as Api.GetTransactionResponse;

/** A scripted fake RPC: each call takes the next scripted answer (or the last one). */
function fakeRpc(script: {
  send: (Api.SendTransactionResponse | "hang")[];
  poll?: Api.GetTransactionResponse | "hang";
  lookup?: Api.GetTransactionResponse;
}) {
  const sends = [...script.send];
  const rpc = {
    sendTransaction: vi.fn(async (tx: Transaction) => {
      const next = sends.length > 1 ? sends.shift()! : sends[0]!;
      if (next === "hang") return never<Api.SendTransactionResponse>();
      return { ...next, hash: tx.hash().toString("hex") };
    }),
    pollTransaction: vi.fn(async () => (script.poll === "hang" ? never<Api.GetTransactionResponse>() : script.poll ?? success)),
    getTransaction: vi.fn(async () => script.lookup ?? notFound),
  };
  return rpc as typeof rpc & LifecycleRpc;
}

const pending = { status: "PENDING" } as Api.SendTransactionResponse;
const tryLater = { status: "TRY_AGAIN_LATER" } as Api.SendTransactionResponse;
const fast = resolveLifecycleOptions({ sendTimeoutMs: 20, confirmTimeoutMs: 20, tryAgainLaterBackoffMs: 1 });
const rejectError = () => {
  throw new Error("rejected");
};

describe("sendAndConfirm (issue #62)", () => {
  it("happy path: reports the hash before sending, sends once and confirms", async () => {
    const tx = makeTx();
    const rpc = fakeRpc({ send: [pending] });
    const order: string[] = [];
    rpc.sendTransaction.mockImplementationOnce(async (t: Transaction) => {
      order.push("send");
      return { ...pending, hash: t.hash().toString("hex") };
    });
    const result = await sendAndConfirm(rpc, tx, {
      lifecycle: fast,
      pollAttempts: 5,
      onHash: (hash) => void order.push(`hash:${hash}`),
      onError: rejectError,
    });
    const hash = tx.hash().toString("hex");
    expect(order).toEqual([`hash:${hash}`, "send"]);
    expect(result.hash).toBe(hash);
    expect(rpc.sendTransaction).toHaveBeenCalledTimes(1);
    expect(rpc.pollTransaction).toHaveBeenCalledWith(hash, { attempts: 5 });
  });

  it("does not send when the hash callback fails", async () => {
    const rpc = fakeRpc({ send: [pending] });
    await expect(
      sendAndConfirm(rpc, makeTx(), {
        lifecycle: fast,
        pollAttempts: 5,
        onHash: () => Promise.reject(new Error("db down")),
        onError: rejectError,
      }),
    ).rejects.toThrow("db down");
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
  });

  it("retries TRY_AGAIN_LATER with the same envelope, then succeeds", async () => {
    const tx = makeTx();
    const rpc = fakeRpc({ send: [tryLater, tryLater, pending] });
    const result = await sendAndConfirm(rpc, tx, { lifecycle: fast, pollAttempts: 5, onError: rejectError });
    expect(result.hash).toBe(tx.hash().toString("hex"));
    expect(rpc.sendTransaction).toHaveBeenCalledTimes(3);
    for (const [sent] of rpc.sendTransaction.mock.calls) expect(sent).toBe(tx);
  });

  it("gives up after the TRY_AGAIN_LATER budget", async () => {
    const rpc = fakeRpc({ send: [tryLater] });
    const lifecycle = { ...fast, maxTryAgainLaterAttempts: 2 };
    const error = await sendAndConfirm(rpc, makeTx(), { lifecycle, pollAttempts: 5, onError: rejectError }).catch((e) => e);
    expect(error).toBeInstanceOf(TryAgainLaterExhaustedError);
    expect((error as TryAgainLaterExhaustedError).attempts).toBe(3);
    expect(rpc.sendTransaction).toHaveBeenCalledTimes(3);
    expect(rpc.pollTransaction).not.toHaveBeenCalled();
  });

  it("maps an ERROR send response through onError", async () => {
    const rpc = fakeRpc({ send: [{ status: "ERROR" } as Api.SendTransactionResponse] });
    await expect(sendAndConfirm(rpc, makeTx(), { lifecycle: fast, pollAttempts: 5, onError: rejectError })).rejects.toThrow(
      "rejected",
    );
  });

  it("confirm timeout is resolved by a lookup by hash, not a resubmission", async () => {
    const tx = makeTx();
    const rpc = fakeRpc({ send: [pending], poll: "hang", lookup: success });
    const result = await sendAndConfirm(rpc, tx, { lifecycle: fast, pollAttempts: 5, onError: rejectError });
    expect(result.hash).toBe(tx.hash().toString("hex"));
    expect(rpc.getTransaction).toHaveBeenCalledWith(tx.hash().toString("hex"));
    expect(rpc.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("timed out but landed: the send times out, the transaction lands, and it is never resubmitted", async () => {
    const tx = makeTx();
    const hashes: string[] = [];
    const rpc = fakeRpc({ send: ["hang"], poll: notFound, lookup: success });
    const result = await sendAndConfirm(rpc, tx, {
      lifecycle: fast,
      pollAttempts: 5,
      onHash: (hash) => void hashes.push(hash),
      onError: rejectError,
    });
    const hash = tx.hash().toString("hex");
    expect(hashes).toEqual([hash]);
    expect(result.hash).toBe(hash);
    expect(rpc.sendTransaction).toHaveBeenCalledTimes(1);
    expect(rpc.pollTransaction).toHaveBeenCalledWith(hash, { attempts: 5 });
    expect(rpc.getTransaction).toHaveBeenCalledWith(hash);
  });

  it("throws TransactionPendingError with the hash when the status stays unknown", async () => {
    const tx = makeTx();
    const rpc = fakeRpc({ send: [pending], poll: "hang", lookup: notFound });
    const error = await sendAndConfirm(rpc, tx, { lifecycle: fast, pollAttempts: 5, onError: rejectError }).catch((e) => e);
    expect(error).toBeInstanceOf(TransactionPendingError);
    expect((error as TransactionPendingError).hash).toBe(tx.hash().toString("hex"));
    expect((error as Error).message).toMatch(/not confirmed within 20 ms; it may still land/);
    expect(rpc.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("treats a lookup that throws as still pending", async () => {
    const rpc = fakeRpc({ send: [pending], poll: notFound });
    rpc.getTransaction.mockRejectedValueOnce(new Error("rpc down"));
    await expect(sendAndConfirm(rpc, makeTx(), { lifecycle: fast, pollAttempts: 3, onError: rejectError })).rejects.toThrow(
      /not confirmed after 3 polls/,
    );
  });

  it("reports an on-chain failure as TransactionFailedError", async () => {
    const rpc = fakeRpc({ send: [pending], poll: failed });
    await expect(
      sendAndConfirm(rpc, makeTx(), { lifecycle: fast, pollAttempts: 5, onError: rejectError }),
    ).rejects.toBeInstanceOf(TransactionFailedError);
  });
});

describe("lifecycle options", () => {
  it("applies defaults per field and lets later layers override", () => {
    expect(resolveLifecycleOptions()).toEqual(DEFAULT_LIFECYCLE_OPTIONS);
    expect(resolveLifecycleOptions({ sendTimeoutMs: 5 }, { confirmTimeoutMs: 7 })).toEqual({
      ...DEFAULT_LIFECYCLE_OPTIONS,
      sendTimeoutMs: 5,
      confirmTimeoutMs: 7,
    });
  });

  it("rejects negative or non-finite values", () => {
    expect(() => resolveLifecycleOptions({ confirmTimeoutMs: -1 })).toThrow(RangeError);
    expect(() => resolveLifecycleOptions({ sendTimeoutMs: Number.NaN })).toThrow(RangeError);
  });

  it("withStageTimeout raises RequestTimeoutError", async () => {
    await expect(withStageTimeout(never(), 5, "Simulation")).rejects.toBeInstanceOf(RequestTimeoutError);
    await expect(withStageTimeout(Promise.resolve(1), 50, "Simulation")).resolves.toBe(1);
  });
});
