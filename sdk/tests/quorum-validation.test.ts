/**
 * Offline unit tests for the SDK's client-side validation of the M-of-N
 * releaser feature (issue #119, docs/adr/0007). These exercise the fail-fast
 * checks only: every case below must throw *before* any RPC call, so the
 * suite makes no network requests and is safe for CI.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { EscrowClient, MAX_RELEASERS } from "../src/index.js";

const client = new EscrowClient({
  // Never contacted: validation fails before the client is built.
  contractId: Keypair.random().publicKey(),
  rpcUrl: "https://127.0.0.1:1",
});

const payer = Keypair.random();
const other = Keypair.random().publicKey();

function createParams(overrides: Record<string, unknown>) {
  return {
    payer,
    payee: Keypair.random().publicKey(),
    token: Keypair.random().publicKey(),
    amount: 1_000_000n,
    conditionRef: "quorum-validation",
    releasers: [Keypair.random().publicKey(), Keypair.random().publicKey()],
    threshold: 2,
    ...overrides,
  } as never;
}

describe("createQuorumEscrow validation", () => {
  it("rejects an empty releaser set", async () => {
    await expect(
      client.createQuorumEscrow(createParams({ releasers: [] }))
    ).rejects.toThrow(/at least one address/);
  });

  it("rejects more releasers than the contract allows", async () => {
    const releasers = Array.from({ length: MAX_RELEASERS + 1 }, () =>
      Keypair.random().publicKey()
    );
    await expect(
      client.createQuorumEscrow(createParams({ releasers, threshold: 1 }))
    ).rejects.toThrow(new RegExp(`at most ${MAX_RELEASERS}`));
  });

  it("rejects duplicate releasers", async () => {
    const releaser = Keypair.random().publicKey();
    await expect(
      client.createQuorumEscrow(
        createParams({ releasers: [releaser, releaser], threshold: 2 })
      )
    ).rejects.toThrow(/duplicate/);
  });

  it("rejects a threshold below 1 or above the set size", async () => {
    for (const threshold of [0, 3, 1.5]) {
      await expect(
        client.createQuorumEscrow(createParams({ threshold }))
      ).rejects.toThrow(/threshold/);
    }
  });

  it("rejects an oversized conditionRef", async () => {
    await expect(
      client.createQuorumEscrow(createParams({ conditionRef: "a".repeat(65) }))
    ).rejects.toThrow(/conditionRef/);
  });

  it("accepts the maximum set size with a threshold of 1", async () => {
    // Passes validation and only then needs the network, so it fails with a
    // connection error rather than one of the validation errors above.
    const releasers = Array.from({ length: MAX_RELEASERS }, () =>
      Keypair.random().publicKey()
    );
    await expect(
      client.createQuorumEscrow(createParams({ releasers, threshold: 1 }))
    ).rejects.not.toThrow(/releasers must|threshold must|conditionRef must/);
  });
});

describe("M-of-N settlement approval validation", () => {
  it("rejects an empty approver list", async () => {
    await expect(
      client.releaseWithApprovals({ escrowId: 0n, approvers: [] })
    ).rejects.toThrow(/at least one releaser keypair/);
  });

  it("rejects the same keypair listed twice — one key is one approval", async () => {
    const approver = Keypair.random();
    await expect(
      client.releaseWithApprovals({ escrowId: 0n, approvers: [approver, approver] })
    ).rejects.toThrow(/must not repeat/);

    await expect(
      client.refundWithApprovals({ escrowId: 0n, approvers: [approver, approver] })
    ).rejects.toThrow(/must not repeat/);
  });
});
