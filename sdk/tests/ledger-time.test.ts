// Offline tests for the ledger-clock helper (issue #335). The RPC is a plain
// fake, so nothing here touches the network.
import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  DEFAULT_LEDGER_TIME_CACHE_MS,
  EscrowClient,
  LedgerClock,
  type LatestLedger,
} from "../src/index.js";

function makeClock(closeTime: number | undefined = 1_700_000_005, sequence = 42) {
  let nowMs = 1_700_000_000_000;
  const readLatestLedger = vi.fn(async (): Promise<LatestLedger> => ({ sequence, closeTime }));
  const clock = new LedgerClock(readLatestLedger, () => nowMs);
  return {
    clock,
    readLatestLedger,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("LedgerClock", () => {
  it("reads the latest ledger's close time and derives the offset", async () => {
    const { clock } = makeClock(1_700_000_005);

    const time = await clock.get();

    // closeTime 1_700_000_005 s vs local 1_700_000_000_000 ms → +5 000 ms.
    expect(time).toEqual({ closeTime: 1_700_000_005n, sequence: 42, offsetMs: 5_000 });
  });

  it("reuses a read younger than the cache window", async () => {
    const { clock, readLatestLedger, advance } = makeClock();

    await clock.get();
    advance(DEFAULT_LEDGER_TIME_CACHE_MS - 1);
    await clock.get();

    expect(readLatestLedger).toHaveBeenCalledTimes(1);
  });

  it("never serves a value older than maxAgeMs", async () => {
    const { clock, readLatestLedger, advance } = makeClock();

    await clock.get({ maxAgeMs: 1_000 });
    advance(1_000);
    await clock.get({ maxAgeMs: 1_000 });

    expect(readLatestLedger).toHaveBeenCalledTimes(2);
  });

  it("always reads fresh with maxAgeMs: 0", async () => {
    const { clock, readLatestLedger } = makeClock();

    await clock.get({ maxAgeMs: 0 });
    await clock.get({ maxAgeMs: 0 });

    expect(readLatestLedger).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent reads into one request", async () => {
    const { clock, readLatestLedger } = makeClock();

    const [a, b] = await Promise.all([clock.get(), clock.get()]);

    expect(readLatestLedger).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("clear() forces the next read to hit the network", async () => {
    const { clock, readLatestLedger } = makeClock();

    await clock.get();
    clock.clear();
    await clock.get();

    expect(readLatestLedger).toHaveBeenCalledTimes(2);
  });

  it("rejects a negative cache window", async () => {
    const { clock } = makeClock();
    await expect(clock.get({ maxAgeMs: -1 })).rejects.toBeInstanceOf(RangeError);
  });

  it("fails clearly when the RPC omits the close time", async () => {
    const clock = new LedgerClock(async () => ({ sequence: 1 }), () => 0);
    await expect(clock.get()).rejects.toThrow(/close time/);
  });
});

describe("EscrowClient ledger time", () => {
  function clientWith(getLatestLedger: () => Promise<unknown>) {
    return Object.assign(
      new EscrowClient({ contractId: Keypair.random().publicKey(), rpcUrl: "https://127.0.0.1:1" }),
      { rpc: { getLatestLedger } },
    );
  }

  it("caches getLedgerTime and exposes the same offset through ledgerClockOffset", async () => {
    const getLatestLedger = vi.fn(async () => ({ sequence: 7, closeTime: 1_700_000_000 }));
    const client = clientWith(getLatestLedger);

    const time = await client.getLedgerTime();
    expect(time.sequence).toBe(7);
    expect(time.closeTime).toBe(1_700_000_000n);

    await client.getLedgerTime();
    expect(getLatestLedger).toHaveBeenCalledTimes(1);
    expect(await client.ledgerClockOffset()).toBe(time.offsetMs);
  });

  it("refetches when asked to bypass the cache", async () => {
    const getLatestLedger = vi.fn(async () => ({ sequence: 7, closeTime: 1_700_000_000 }));
    const client = clientWith(getLatestLedger);

    await client.getLedgerTime();
    await client.getLedgerTime({ maxAgeMs: 0 });

    expect(getLatestLedger).toHaveBeenCalledTimes(2);
  });
});
