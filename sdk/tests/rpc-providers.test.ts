import { describe, expect, it } from "vitest";
import { RpcProviderPool, type RpcProviderConfig } from "../src/index.js";

function fakeProviders(ledgers: Record<string, number>, failures: Set<string> = new Set()) {
  return (config: RpcProviderConfig) => ({
    getLatestLedger: async () => {
      if (failures.has(config.url)) throw new Error(`${config.url} unavailable`);
      return { sequence: ledgers[config.url]! };
    },
    getNetwork: async () => ({ passphrase: "testnet" }),
  } as never);
}

const configs = [
  { url: "https://preferred.example", priority: 0 },
  { url: "https://backup.example", priority: 10 },
] as const;

describe("RpcProviderPool", () => {
  it("prefers the highest-priority provider that is fresh", async () => {
    const pool = new RpcProviderPool(configs, {
      networkPassphrase: "testnet",
      rpcFactory: fakeProviders({ "https://preferred.example": 100, "https://backup.example": 100 }),
    });
    expect((await pool.select()).url).toBe("https://preferred.example");
  });

  it("skips a provider that is too far behind the freshest ledger", async () => {
    const pool = new RpcProviderPool(configs, {
      networkPassphrase: "testnet",
      rpcFactory: fakeProviders({ "https://preferred.example": 90, "https://backup.example": 100 }),
    });
    expect((await pool.select()).url).toBe("https://backup.example");
  });

  it("fails over an idempotent read after the preferred provider errors", async () => {
    const pool = new RpcProviderPool(configs, {
      networkPassphrase: "testnet",
      rpcFactory: fakeProviders({ "https://preferred.example": 100, "https://backup.example": 100 }, new Set(["https://preferred.example"])),
    });
    const attempted: string[] = [];
    const result = await pool.withReadFailover(async (rpc) => {
      const value = await rpc.getLatestLedger();
      attempted.push(String(value.sequence));
      return value.sequence;
    });
    expect(result).toBe(100);
    expect(attempted).toEqual(["100"]);
  });

  it("rejects a provider reporting another network", async () => {
    const pool = new RpcProviderPool(configs, {
      networkPassphrase: "testnet",
      rpcFactory: (config) => ({
        getLatestLedger: async () => ({ sequence: 100 }),
        getNetwork: async () => ({ passphrase: "mainnet" }),
      } as never),
    });
    await expect(pool.select()).rejects.toThrow(/different network passphrases/);
  });
});
