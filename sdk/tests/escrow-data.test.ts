import { describe, expect, it } from "vitest";
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { EscrowClient } from "../src/index.js";
import { decodeEscrowDataFromScVal } from "../src/escrow-data.js";

function field(name: string, value: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({
    key: xdr.ScVal.scvSymbol(name),
    val: value,
  });
}

function legacyEscrowRecord() {
  const payer = Keypair.random().publicKey();
  const payee = Keypair.random().publicKey();
  const token = Keypair.random().publicKey();
  const releaser = Keypair.random().publicKey();
  // The 2026-10-20 testnet deployment predates `release_not_before`; its
  // get_escrow result is this map, with no field for it.
  const record = xdr.ScVal.scvMap([
    field("accepted_at", xdr.ScVal.scvVoid()),
    field("amount", nativeToScVal(1_000_000n, { type: "i128" })),
    field("condition_ref", nativeToScVal("legacy-layout", { type: "string" })),
    field("notify_payee", nativeToScVal(false, { type: "bool" })),
    field("payee", new Address(payee).toScVal()),
    field("payer", new Address(payer).toScVal()),
    field("refund_after", xdr.ScVal.scvVoid()),
    field("refund_to", new Address(payer).toScVal()),
    field("releasers", xdr.ScVal.scvVec([new Address(releaser).toScVal()])),
    field("requires_acceptance", nativeToScVal(false, { type: "bool" })),
    field("status", xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Released")])),
    field("threshold", nativeToScVal(1, { type: "u32" })),
    field("token", new Address(token).toScVal()),
  ]);
  return { record, payer, payee, token, releaser };
}

describe("get_escrow cross-version decoding", () => {
  it("decodes a deployment that predates release_not_before by field name", () => {
    const { record, payer, payee, token, releaser } = legacyEscrowRecord();

    const escrow = decodeEscrowDataFromScVal(record);

    expect(escrow.payer).toBe(payer);
    expect(escrow.payee).toBe(payee);
    expect(escrow.token).toBe(token);
    expect(escrow.amount).toBe(1_000_000n);
    expect(escrow.conditionRef).toBe("legacy-layout");
    expect(escrow.releasers).toEqual([releaser]);
    expect(escrow.threshold).toBe(1);
    expect(escrow.refundAfter).toBeUndefined();
    expect(escrow.releaseNotBefore).toBeUndefined();
    expect(escrow.notifyPayee).toBe(false);
    expect(escrow.refundTo).toBe(payer);
    expect(escrow.status).toBe("Released");
  });

  it("falls back to name-based decoding when the generated spec mis-aligns a legacy record", async () => {
    const { record, payer } = legacyEscrowRecord();
    const layoutError = new TypeError(
      "Type [object Object] was not vec, but [object Object] is"
    );
    const fakeTx = {
      simulationData: { result: { retval: record } },
      get result(): never {
        throw layoutError;
      },
    };
    const client = Object.assign(
      new EscrowClient({
        contractId: Keypair.random().publicKey(),
        rpcUrl: "https://127.0.0.1:1",
        verifyNetwork: false,
      }),
      { contractClient: () => ({ get_escrow: async () => fakeTx }) }
    );

    const escrow = await client.getEscrow(4n);

    expect(escrow.refundTo).toBe(payer);
    expect(escrow.status).toBe("Released");
    expect(escrow.releaseNotBefore).toBeUndefined();
  });

  it("rethrows a decode failure when the result is not an escrow map", async () => {
    const layoutError = new TypeError("not an escrow record");
    const fakeTx = {
      simulationData: { result: { retval: xdr.ScVal.scvVoid() } },
      get result(): never {
        throw layoutError;
      },
    };
    const client = Object.assign(
      new EscrowClient({
        contractId: Keypair.random().publicKey(),
        rpcUrl: "https://127.0.0.1:1",
        verifyNetwork: false,
      }),
      { contractClient: () => ({ get_escrow: async () => fakeTx }) }
    );

    await expect(client.getEscrow(5n)).rejects.toBe(layoutError);
  });
});
