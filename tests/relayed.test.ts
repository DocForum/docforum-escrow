import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { EscrowClient } from "../src/index";

describe("relayed settlement authorization", () => {
  it("collects only the releaser's auth entry and leaves the envelope unsigned", async () => {
    const releaser = Keypair.random();
    const client = new EscrowClient({ offline: true });
    const auth = await client.authorizeSettlement({ signer: releaser, escrowId: 1n, expiresAtLedger: 500 });
    expect(auth.signedEntries).toHaveLength(1);
    expect(auth.signedEntries[0].address).toBe(releaser.publicKey());
    expect(auth.envelopeSigned).toBe(false);
  });

  it("uses the refund entry point for authorizeRefund", async () => {
    const payer = Keypair.random();
    const client = new EscrowClient({ offline: true });
    const auth = await client.authorizeRefund({ signer: payer, escrowId: 1n, expiresAtLedger: 500 });
    expect(auth.method).toBe("refund");
  });

  it("rejects a read-only simulation instead of returning an unusable authorization", async () => {
    const client = new EscrowClient({ offline: true, simulate: async () => ({ readOnly: true }) });
    await expect(
      client.authorizeSettlement({ signer: Keypair.random(), escrowId: 1n, expiresAtLedger: 500 })
    ).rejects.toThrow(/read-only/i);
  });

  it("submits the restored authorization with the relayer's envelope signature", async () => {
    const client = new EscrowClient({ offline: true });
    const relayer = Keypair.random();
    const auth = await client.authorizeSettlement({ signer: Keypair.random(), escrowId: 1n, expiresAtLedger: 500 });
    const result = await client.submitSettlement(JSON.stringify(auth), relayer);
    expect(result.submittedBy).toBe(relayer.publicKey());
  });

  it("refuses to submit a release authorization as a refund", async () => {
    const client = new EscrowClient({ offline: true });
    const auth = await client.authorizeSettlement({ signer: Keypair.random(), escrowId: 1n, expiresAtLedger: 500 });
    await expect(
      client.submitRefund(JSON.stringify(auth), Keypair.random())
    ).rejects.toThrow(/method/i);
  });

  it("reports malformed authorization JSON instead of a parser stack trace", async () => {
    const client = new EscrowClient({ offline: true });
    await expect(client.submitSettlement("{not json", Keypair.random())).rejects.toThrow(/malformed authorization/i);
  });

  it("rejects a rotation authorization whose expiration ledger has passed before submit", async () => {
    const client = new EscrowClient({ offline: true, currentLedger: async () => 1000 });
    await expect(
      client.submitRotation(
        { transaction: JSON.stringify({ method: "rotate_releaser" }), expiresAtLedger: 500 },
        Keypair.random()
      )
    ).rejects.toThrow(/expired/i);
  });

  it("submits a rotation with the submitter's signature only, after both auth entries are present", async () => {
    const client = new EscrowClient({ offline: true, currentLedger: async () => 100 });
    const transaction = JSON.stringify({
      method: "rotate_releaser",
      authEntries: [{ signer: "releaser" }, { signer: "payer" }],
    });
    const submitter = Keypair.random();
    const result = await client.submitRotation(
      { transaction, expiresAtLedger: 500 },
      submitter
    );
    expect(result.submittedBy).toBe(submitter.publicKey());
  });
});
