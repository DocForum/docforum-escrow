import { describe, it, expect } from "vitest";
import { EscrowClient } from "../src/index";
import { utf8ByteLength, MAX_CONDITION_REF_LENGTH } from "../src/escrow-types";

const CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

function makeClient(): EscrowClient {
  return new EscrowClient({
    contractId: CONTRACT_ID,
    rpcUrl: RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
}

function pooledCreateParams(overrides: Record<string, unknown> = {}) {
  return {
    conditionRef: "ref-ok",
    fundingTarget: 1000n,
    fundingDeadline: 1_900_000_000n,
    ...overrides,
  } as any;
}

describe("createPooledEscrow validation", () => {
  it("rejects an oversized conditionRef", async () => {
    const client = makeClient();
    await expect(
      client.createPooledEscrow(pooledCreateParams({ conditionRef: "a".repeat(65) })),
    ).rejects.toThrow(/conditionRef/);
  });

  it("rejects a conditionRef over the byte limit even when its char count fits", async () => {
    const client = makeClient();
    // 40 chars, each 2 bytes in UTF-8 => 80 bytes > 64
    await expect(
      client.createPooledEscrow(pooledCreateParams({ conditionRef: "é".repeat(40) })),
    ).rejects.toThrow(/conditionRef/);
  });

  it("rejects a non-positive funding target", async () => {
    const client = makeClient();
    await expect(
      client.createPooledEscrow(pooledCreateParams({ fundingTarget: 0n })),
    ).rejects.toThrow();
  });

  it("rejects a non-positive funding deadline", async () => {
    const client = makeClient();
    await expect(
      client.createPooledEscrow(pooledCreateParams({ fundingDeadline: 0n })),
    ).rejects.toThrow();
  });

  it("passes validation for a well-formed request, then needs the network", async () => {
    const client = makeClient();
    const err = await client
      .createPooledEscrow(pooledCreateParams())
      .catch((e: unknown) => e);
    expect(String(err)).not.toMatch(/conditionRef/);
  });

  it("counts astral (emoji) characters as 4 bytes", () => {
    expect(utf8ByteLength("😀")).toBe(4);
    expect(utf8ByteLength("😀".repeat(16))).toBe(64);
    expect(utf8ByteLength("😀".repeat(17))).toBe(68);
  });

  it("rejects zero and negative contribution amounts", async () => {
    const client = makeClient();
    await expect(
      client.createPooledEscrow(pooledCreateParams({ fundingTarget: -1n })),
    ).rejects.toThrow();
  });
});

describe("utf8ByteLength boundary", () => {
  it("accepts exactly 64 bytes and rejects 65 for multi-byte input", async () => {
    expect(MAX_CONDITION_REF_LENGTH).toBe(64);
    const client = makeClient();
    // 32 x 2-byte chars = 64 bytes: must pass the length check
    const ok = await client
      .createPooledEscrow(pooledCreateParams({ conditionRef: "é".repeat(32) }))
      .catch((e: unknown) => e);
    expect(String(ok)).not.toMatch(/conditionRef/);
    // 33 x 2-byte chars = 66 bytes: must fail
    await expect(
      client.createPooledEscrow(pooledCreateParams({ conditionRef: "é".repeat(33) })),
    ).rejects.toThrow(/conditionRef/);
  });
});
