import { afterEach, describe, expect, it, vi } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import {
  EscrowClient,
  EventCursorExpiredError,
  type Escrow,
  type EscrowEvent,
} from "../src/index.js";
import { NotFoundError } from "../src/errors.js";
import {
  checkSolvency,
  SolvencyHistoryIncompleteError,
  type SolvencyBalanceSource,
} from "../src/solvency.js";

const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));
const tokenA = StrKey.encodeContract(Buffer.alloc(32, 2));
const tokenB = StrKey.encodeContract(Buffer.alloc(32, 3));
const rpcUrl = "https://rpc.example.test";

function fundedEscrow(token: string, amount: bigint): Escrow {
  return {
    payer: "GPAYER",
    payee: "GPAYEE",
    token,
    amount,
    conditionRef: "test-record",
    releasers: ["GRELEASER"],
    threshold: 1,
    notifyPayee: false,
    refundTo: "GPAYER",
    requiresAcceptance: false,
    status: "Funded",
  };
}

function createdEvent(escrowId: bigint, ledger = 42): EscrowEvent {
  return {
    type: "created",
    escrowId,
    ledger,
    cursor: `ledger-${ledger}:tx-0:event-0`,
    transactionHash: "a".repeat(64),
    data: 0n,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkSolvency", () => {
  it("checks every token through the on-chain view and reports solvent", async () => {
    const getSolvency = vi.spyOn(EscrowClient.prototype, "getSolvency").mockImplementation(async (token: string) => {
      if (token === tokenA) return { balance: 1000n, liabilities: 400n, solvent: true };
      return { balance: 500n, liabilities: 500n, solvent: true };
    });

    const result = await checkSolvency({ contractId, tokens: [tokenA, tokenB], rpcUrl });

    expect(getSolvency).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      contractId,
      tokens: [
        { token: tokenA, balance: 1000n, liabilities: 400n, solvent: true, source: "on-chain" },
        { token: tokenB, balance: 500n, liabilities: 500n, solvent: true, source: "on-chain" },
      ],
      solvent: true,
      shortfalls: [],
    });
  });

  it("reports a shortfall per token", async () => {
    vi.spyOn(EscrowClient.prototype, "getSolvency").mockImplementation(async (token: string) => {
      if (token === tokenA) return { balance: 1000n, liabilities: 400n, solvent: true };
      return { balance: 100n, liabilities: 250n, solvent: false };
    });

    const result = await checkSolvency({ contractId, tokens: [tokenA, tokenB], rpcUrl });

    expect(result.solvent).toBe(false);
    expect(result.shortfalls).toEqual([{ token: tokenB, shortfall: 150n }]);
    expect(result.tokens[1]).toMatchObject({ token: tokenB, solvent: false, source: "on-chain" });
  });

  it("rebuilds liabilities from events when the deployment predates the solvency view", async () => {
    vi.spyOn(EscrowClient.prototype, "getSolvency").mockRejectedValue(
      new Error("contract call failed: Error(WasmVm, MissingValue)"),
    );
    const getEvents = vi.spyOn(EscrowClient.prototype, "getEvents").mockResolvedValue({
      events: [createdEvent(1n), createdEvent(2n)],
      nextCursor: "cursor-2",
    });
    vi.spyOn(EscrowClient.prototype, "getEscrow").mockImplementation(async (escrowId: bigint) => {
      if (escrowId === 1n) return fundedEscrow(tokenA, 300n);
      throw new NotFoundError();
    });
    const balanceSource: SolvencyBalanceSource = {
      getTokenBalance: async (token: string) => (token === tokenA ? 1000n : 100n),
    };

    const result = await checkSolvency({ contractId, tokens: [tokenA, tokenB], rpcUrl, balanceSource });

    expect(getEvents).toHaveBeenCalledWith({ fromLedger: 1, types: ["created"] });
    expect(result).toEqual({
      contractId,
      tokens: [
        { token: tokenA, balance: 1000n, liabilities: 300n, solvent: true, source: "events" },
        { token: tokenB, balance: 100n, liabilities: 0n, solvent: true, source: "events" },
      ],
      solvent: true,
      shortfalls: [],
    });
  });

  it("flags a simulated clawback shortfall rebuilt from events", async () => {
    vi.spyOn(EscrowClient.prototype, "getSolvency").mockRejectedValue(
      new Error("non-existent contract function solvency"),
    );
    vi.spyOn(EscrowClient.prototype, "getEvents").mockResolvedValue({
      events: [createdEvent(1n)],
      nextCursor: "cursor-2",
    });
    vi.spyOn(EscrowClient.prototype, "getEscrow").mockResolvedValue(fundedEscrow(tokenA, 300n));
    const balanceSource: SolvencyBalanceSource = {
      getTokenBalance: async () => 100n,
    };

    const result = await checkSolvency({ contractId, tokens: [tokenA], rpcUrl, balanceSource });

    expect(result.solvent).toBe(false);
    expect(result.shortfalls).toEqual([{ token: tokenA, shortfall: 200n }]);
    expect(result.tokens[0]).toMatchObject({ token: tokenA, balance: 100n, liabilities: 300n, source: "events" });
  });

  it("throws instead of understating liabilities when event history is incomplete", async () => {
    vi.spyOn(EscrowClient.prototype, "getSolvency").mockRejectedValue(
      new Error("non-existent contract function solvency"),
    );
    vi.spyOn(EscrowClient.prototype, "getEvents").mockRejectedValue(new EventCursorExpiredError());

    await expect(checkSolvency({ contractId, tokens: [tokenA], rpcUrl })).rejects.toBeInstanceOf(
      SolvencyHistoryIncompleteError,
    );
  });

  it("rejects invalid addresses, an empty token list, and a bad fromLedger", async () => {
    await expect(checkSolvency({ contractId: "not-an-address", tokens: [tokenA] })).rejects.toThrow(TypeError);
    await expect(checkSolvency({ contractId, tokens: [] })).rejects.toThrow(TypeError);
    await expect(checkSolvency({ contractId, tokens: [tokenA], fromLedger: 0 })).rejects.toThrow(RangeError);
  });
});
