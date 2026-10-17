import { describe, expect, it } from "vitest";
import type { Keypair } from "@stellar/stellar-sdk";
import type { EscrowClient, EscrowStatus } from "../src/index.js";

export interface EscrowConformanceFixture {
  client: Pick<EscrowClient, "createEscrow" | "getStatus" | "getEscrow" | "release" | "refund">;
  payer: Keypair;
  payee: string;
  token: string;
  releaser: Keypair;
  stranger: Keypair;
  amount: bigint;
  conditionRef: string;
}

/** Register the shared behavioral scenarios for a fake or contract-backed client. */
export function registerEscrowConformanceSuite(
  name: string,
  makeFixture: () => Promise<EscrowConformanceFixture> | EscrowConformanceFixture,
  skip = false,
): void {
  const suite = skip ? describe.skip : describe;
  suite(name, () => {
    it("creates and reads a funded escrow", async () => {
      const fixture = await makeFixture();
      const { escrowId, txHash } = await fixture.client.createEscrow({
        payer: fixture.payer,
        payee: fixture.payee,
        token: fixture.token,
        amount: fixture.amount,
        conditionRef: `${fixture.conditionRef}-read`,
        releaser: fixture.releaser.publicKey(),
      });

      expect(txHash).toBeTruthy();
      expect(await fixture.client.getStatus(escrowId)).toBe("Funded");
      expect(await fixture.client.getEscrow(escrowId)).toMatchObject({
        payer: fixture.payer.publicKey(),
        payee: fixture.payee,
        amount: fixture.amount,
        releaser: fixture.releaser.publicKey(),
        status: "Funded" satisfies EscrowStatus,
      });
    });

    it("restricts release to the releaser and prevents double settlement", async () => {
      const fixture = await makeFixture();
      const { escrowId } = await fixture.client.createEscrow({
        payer: fixture.payer,
        payee: fixture.payee,
        token: fixture.token,
        amount: fixture.amount,
        conditionRef: `${fixture.conditionRef}-release`,
        releaser: fixture.releaser.publicKey(),
      });

      await expect(fixture.client.release({ escrowId, caller: fixture.stranger })).rejects.toThrow();
      await fixture.client.release({ escrowId, caller: fixture.releaser });
      expect(await fixture.client.getStatus(escrowId)).toBe("Released");
      await expect(fixture.client.release({ escrowId, caller: fixture.releaser })).rejects.toThrow();
    });

    it("allows the releaser to refund a funded escrow", async () => {
      const fixture = await makeFixture();
      const { escrowId } = await fixture.client.createEscrow({
        payer: fixture.payer,
        payee: fixture.payee,
        token: fixture.token,
        amount: fixture.amount,
        conditionRef: `${fixture.conditionRef}-refund`,
        releaser: fixture.releaser.publicKey(),
      });

      await fixture.client.refund({ escrowId, caller: fixture.releaser });
      expect(await fixture.client.getStatus(escrowId)).toBe("Refunded");
      await expect(fixture.client.refund({ escrowId, caller: fixture.releaser })).rejects.toThrow();
    });
  });
}
