// Offline tests for ChannelAccountPool (issue #132). No network: the pool
// is pure bookkeeping, so every scheduling rule can be checked here.
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { ChannelAccountPool } from "../src/channel-accounts.js";

function channels(count: number): Keypair[] {
  return Array.from({ length: count }, () => Keypair.random());
}

describe("ChannelAccountPool", () => {
  it("rejects an empty or duplicate pool", () => {
    expect(() => new ChannelAccountPool([])).toThrow(/at least one/);
    const one = Keypair.random();
    expect(() => new ChannelAccountPool([one, one])).toThrow(/duplicate/);
  });

  it("hands out exclusive channels and never exceeds its size", async () => {
    const pool = new ChannelAccountPool(channels(3));
    const held = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
    expect(new Set(held.map((c) => c.publicKey())).size).toBe(3);
    expect(pool.inUse).toBe(3);
    expect(pool.available).toBe(0);

    for (const channel of held) pool.release(channel);
    expect(pool.inUse).toBe(0);
    expect(pool.available).toBe(3);
  });

  it("queues waiters in FIFO order and serves them on release", async () => {
    const pool = new ChannelAccountPool(channels(1));
    const first = await pool.acquire();
    const served: string[] = [];

    const second = pool.run(async (channel) => {
      served.push("second");
      return channel.publicKey();
    });
    const third = pool.run(async () => {
      served.push("third");
    });

    expect(pool.available).toBe(0);
    expect(served).toEqual([]);

    pool.release(first);
    await second;
    await third;

    expect(served).toEqual(["second", "third"]);
    expect(pool.inUse).toBe(0);
    expect(pool.available).toBe(1);
  });

  it("releases the channel when the operation throws", async () => {
    const pool = new ChannelAccountPool(channels(2));

    await expect(
      pool.run(async () => {
        expect(pool.inUse).toBe(1);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(pool.inUse).toBe(0);
    expect(pool.available).toBe(2);
  });

  it("keeps concurrency at or below the channel count under a burst", async () => {
    const pool = new ChannelAccountPool(channels(4));
    let active = 0;
    let maxActive = 0;
    const seen = new Set<string>();

    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        pool.run(async (channel) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          seen.add(channel.publicKey());
          // Yield so overlap would be visible if the pool let it happen.
          await new Promise((resolve) => setTimeout(resolve, i % 3));
          active -= 1;
        }),
      ),
    );

    expect(maxActive).toBe(4);
    expect(seen.size).toBe(4);
    expect(pool.inUse).toBe(0);
    expect(pool.available).toBe(4);
  });

  it("failFast rejects when every channel is busy", async () => {
    const pool = new ChannelAccountPool(channels(1), { failFast: true });
    const channel = await pool.acquire();
    await expect(pool.acquire()).rejects.toThrow(/No idle channel/);
    pool.release(channel);
    await expect(pool.acquire()).resolves.toBeInstanceOf(Keypair);
  });

  it("rejects queued waiters on close and refuses new acquisitions", async () => {
    const pool = new ChannelAccountPool(channels(1));
    const channel = await pool.acquire();
    const queued = pool.acquire();

    pool.close();
    await expect(queued).rejects.toThrow(/closed/);
    await expect(pool.acquire()).rejects.toThrow(/closed/);

    // The in-flight checkout can still be returned without throwing.
    expect(() => pool.release(channel)).not.toThrow();
  });

  it("rejects releasing a channel it did not hand out", () => {
    const pool = new ChannelAccountPool(channels(1));
    expect(() => pool.release(Keypair.random())).toThrow(/not checked out/);
  });
});
