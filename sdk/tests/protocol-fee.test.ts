/**
 * Offline unit tests for the optional protocol fee (issue #30, ADR 0010).
 * `createEscrow` validates the fee pair before it builds or simulates a
 * transaction, so every assertion here fails fast with no network access.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { EscrowClient, MAX_FEE_BPS } from "../src/index.js";

const client = new EscrowClient({ contractId: Keypair.random().publicKey() });
const payer = Keypair.random();

const base = {
  payer,
  payee: Keypair.random().publicKey(),
  token: Keypair.random().publicKey(),
  amount: 300n,
  conditionRef: "opaque-condition-ref",
  releaser: Keypair.random().publicKey(),
};

describe("createEscrow protocol fee validation", () => {
  it("rejects a fee recipient without a rate", async () => {
    await expect(
      client.createEscrow({ ...base, feeRecipient: Keypair.random().publicKey() }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects a fee rate without a recipient", async () => {
    await expect(client.createEscrow({ ...base, feeBps: 100 })).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects a rate above the 10 % cap", async () => {
    await expect(
      client.createEscrow({
        ...base,
        feeRecipient: Keypair.random().publicKey(),
        feeBps: MAX_FEE_BPS + 1,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("rejects a negative or fractional rate", async () => {
    const feeRecipient = Keypair.random().publicKey();
    await expect(client.createEscrow({ ...base, feeRecipient, feeBps: -1 })).rejects.toBeInstanceOf(RangeError);
    await expect(client.createEscrow({ ...base, feeRecipient, feeBps: 1.5 })).rejects.toBeInstanceOf(RangeError);
  });
});
