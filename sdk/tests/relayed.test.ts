import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { EscrowClient, RELAYED_AUTH_TTL_LEDGERS } from "../src/index.js";

function makeClient(fakes: Record<string, unknown>): EscrowClient {
  return Object.assign(
    new EscrowClient({
      contractId: Keypair.random().publicKey(),
      rpcUrl: "https://127.0.0.1:1",
      verifyNetwork: false,
    }),
    fakes
  );
}

describe("relayed settlement authorization", () => {
  it("collects only the releaser's auth entry and leaves the envelope unsigned", async () => {
    const releaser = Keypair.random();
    const relayer = Keypair.random();
    const signAuthEntries = vi.fn(async () => {});
    const tx = {
      isReadCall: false,
      needsNonInvokerSigningBy: () => [releaser.publicKey()],
      signAuthEntries,
      toJSON: () => JSON.stringify({ method: "release", tx: "envelope" }),
    };
    const client = makeClient({
      contractClient: () => ({ release: async () => tx }),
      rpc: { getLatestLedger: async () => ({ sequence: 500 }) },
    });

    const authorization = await client.authorizeRelease({
      escrowId: 7n,
      releaser,
      relayer,
    });

    expect(authorization.expiresAtLedger).toBe(500 + RELAYED_AUTH_TTL_LEDGERS);
    expect(JSON.parse(authorization.transaction).method).toBe("release");
    expect(signAuthEntries).toHaveBeenCalledWith({
      signAuthEntry: releaser,
      expiration: authorization.expiresAtLedger,
    });
  });

  it("uses the refund entry point for authorizeRefund", async () => {
    const releaser = Keypair.random();
    const relayer = Keypair.random();
    const refund = vi.fn(async () => ({
      isReadCall: false,
      needsNonInvokerSigningBy: () => [],
      toJSON: () => JSON.stringify({ method: "refund" }),
    }));
    const client = makeClient({
      contractClient: () => ({ refund }),
      rpc: { getLatestLedger: async () => ({ sequence: 100 }) },
    });

    const authorization = await client.authorizeRefund({ escrowId: 3n, releaser, relayer });

    expect(refund).toHaveBeenCalledWith({ escrow_id: 3n, caller: releaser.publicKey() });
    expect(authorization.expiresAtLedger).toBe(100 + RELAYED_AUTH_TTL_LEDGERS);
  });

  it("rejects a read-only simulation instead of returning an unusable authorization", async () => {
    const client = makeClient({
      contractClient: () => ({ release: async () => ({ isReadCall: true }) }),
      rpc: { getLatestLedger: async () => ({ sequence: 1 }) },
    });

    await expect(
      client.authorizeRelease({
        escrowId: 1n,
        releaser: Keypair.random(),
        relayer: Keypair.random(),
      })
    ).rejects.toThrow(/read call/);
  });

  it("submits the restored authorization with the relayer's envelope signature", async () => {
    const unwrap = vi.fn();
    const signAndSend = vi.fn(async () => ({
      result: { unwrap },
      sendTransactionResponse: { hash: "abc123" },
    }));
    const txFromJSON = vi.fn(() => ({ signAndSend }));
    const client = makeClient({ contractClient: () => ({ txFromJSON }) });
    const transaction = JSON.stringify({ method: "release", tx: "envelope" });

    const result = await client.submitRelayed(
      "release",
      { transaction, expiresAtLedger: 10 },
      Keypair.random()
    );

    expect(result.txHash).toBe("abc123");
    expect(unwrap).toHaveBeenCalledTimes(1);
    expect(txFromJSON).toHaveBeenCalledWith(transaction);
  });

  it("refuses to submit a release authorization as a refund", async () => {
    const client = makeClient({
      contractClient: () => {
        throw new Error("must not reach the network");
      },
    });

    await expect(
      client.submitRelayed(
        "refund",
        { transaction: JSON.stringify({ method: "release" }), expiresAtLedger: 10 },
        Keypair.random()
      )
    ).rejects.toThrow(/not refund/);
  });

  it("reports malformed authorization JSON instead of a parser stack trace", async () => {
    const client = makeClient({});
    await expect(
      client.submitRelayed("release", { transaction: "{", expiresAtLedger: 10 }, Keypair.random())
    ).rejects.toThrow(/not valid JSON/);
  });
});
