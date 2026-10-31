import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { EscrowClient } from "../src/index.js";

const client = new EscrowClient({
  contractId: Keypair.random().publicKey(),
  rpcUrl: "https://127.0.0.1:1",
});

const payer = Keypair.random();
const releaser = Keypair.random().publicKey();

function singleParams(overrides: Record<string, unknown>) {
  return {
    payer,
    payee: Keypair.random().publicKey(),
    token: Keypair.random().publicKey(),
    amount: 1_000_000n,
    conditionRef: "dependency-validation",
    releaser,
    dependsOn: { escrowId: 0n, requiredStatus: "Released" },
    ...overrides,
  } as never;
}

function quorumParams(overrides: Record<string, unknown>) {
  return {
    payer,
    payee: Keypair.random().publicKey(),
    token: Keypair.random().publicKey(),
    amount: 1_000_000n,
    conditionRef: "dependency-validation",
    releasers: [releaser],
    threshold: 1,
    dependsOn: { escrowId: 0n, requiredStatus: "Released" },
    ...overrides,
  } as never;
}

describe("dependent escrow creation validation", () => {
  it("rejects negative dependency ids before contacting RPC", async () => {
    await expect(
      client.createDependentEscrow(
        singleParams({ dependsOn: { escrowId: -1n, requiredStatus: "Released" } })
      )
    ).rejects.toThrow(/must not be negative/);
  });

  it("rejects non-terminal dependency statuses", async () => {
    await expect(
      client.createDependentEscrow(
        singleParams({ dependsOn: { escrowId: 0n, requiredStatus: "Funded" } })
      )
    ).rejects.toThrow(/Released or Refunded/);
  });

  it("applies dependency validation to quorum escrow creation", async () => {
    await expect(
      client.createDependentQuorumEscrow(
        quorumParams({ dependsOn: { escrowId: -1n, requiredStatus: "Released" } })
      )
    ).rejects.toThrow(/must not be negative/);
  });
});
