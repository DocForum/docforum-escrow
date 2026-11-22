/**
 * Offline unit tests for the SDK's client-side validation of the pooled
 * escrow feature (issue #113, docs/adr/0011). Fail-fast checks only:
 * every case must reject *before* any RPC call, so the suite makes no
 * network requests and is safe for CI.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { EscrowClient } from "../src/index.js";
import { MAX_CONDITION_REF_LENGTH, utf8ByteLength } from "../src/escrow-types.js";

const client = new EscrowClient({
  // Never contacted: validation fails before the client is built.
  contractId: Keypair.random().publicKey(),
  rpcUrl: "https://127.0.0.1:1",
});

const creator = Keypair.random();

function pooledCreateParams(overrides: Record<string, unknown>) {
  return {
    creator,
    payee: Keypair.random().publicKey(),
    token: Keypair.random().publicKey(),
    fundingTarget: 1_000_000n,
    conditionRef: "pooled-validation",
    releaser: Keypair.random().publicKey(),
    fundingDeadline: 1_760_000_000n,
    ...overrides,
  } as never;
}

describe("createPooledEscrow validation", () => {
  it("rejects an oversized conditionRef", async () => {
    await expect(
      client.createPooledEscrow(pooledCreateParams({ conditionRef: "a".repeat(MAX_CONDITION_REF_LENGTH + 1) }))
    ).rejects.toThrow(/conditionRef/);
  });

  it("rejects a conditionRef over the byte limit even when its char count fits", async () => {
    // 33 two-byte characters = 66 bytes (> 64) but only 33 UTF-16 units.
    await expect(
      client.createPooledEscrow(pooledCreateParams({ conditionRef: "é".repeat(33) }))
    ).rejects.toThrow(/conditionRef/);
  });

  it("rejects a non-positive funding target", async () => {
    for (const fundingTarget of [0n, -1n]) {
      await expect(
        client.createPooledEscrow(pooledCreateParams({ fundingTarget }))
      ).rejects.toThrow(/fundingTarget/);
    }
  });

  it("rejects a non-positive funding deadline", async () => {
    await expect(
      client.createPooledEscrow(pooledCreateParams({ fundingDeadline: 0n }))
    ).rejects.toThrow(/fundingDeadline/);
  });

  it("passes validation for a well-formed request, then needs the network", async () => {
    // Valid input only fails on the (unreachable) RPC connection — i.e. no
    // validation error fired.
    await expect(client.createPooledEscrow(pooledCreateParams({}))).rejects.not.toThrow(
      /conditionRef must|fundingTarget must|fundingDeadline must/
    );
  });
});

describe("utf8ByteLength boundary", () => {
  it("counts astral (emoji) characters as 4 bytes", () => {
    expect(utf8ByteLength("😀")).toBe(4);
    expect(utf8ByteLength("😀".repeat(16))).toBe(64);
  });

  it("accepts exactly 64 bytes and rejects 65 for multi-byte input", async () => {
    // 32 two-byte characters = 64 bytes: must not fail on length.
    await expect(
      client.createPooledEscrow(pooledCreateParams({ conditionRef: "é".repeat(32) }))
    ).rejects.not.toThrow(/conditionRef/);
    // 16 emoji = 64 bytes: must pass the length check.
    await expect(
      client.createPooledEscrow(pooledCreateParams({ conditionRef: "😀".repeat(16) }))
    ).rejects.not.toThrow(/conditionRef/);
    // 16 emoji + 1 ASCII = 65 bytes: must fail.
    await expect(
      client.createPooledEscrow(pooledCreateParams({ conditionRef: "😀".repeat(16) + "a" }))
    ).rejects.toThrow(/conditionRef/);
  });
});

describe("contribute validation", () => {
  it("rejects zero and negative contribution amounts", async () => {
    for (const amount of [0n, -5n]) {
      await expect(
        client.contribute({ escrowId: 7n, payer: creator, amount })
      ).rejects.toThrow(/amount must be/);
    }
  });
});
