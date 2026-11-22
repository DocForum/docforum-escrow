import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { EscrowClient } from "../src/index.js";

type Seed = { label: string; contractId: string; releaseEscrowId: string; refundEscrowId: string };

const seeds: Seed[] = JSON.parse(process.env.COMPATIBILITY_SEEDS ?? "[]");
const rpcUrl = process.env.COMPATIBILITY_RPC_URL;
const networkPassphrase = process.env.COMPATIBILITY_NETWORK_PASSPHRASE;
const releaserSecret = process.env.COMPATIBILITY_RELEASER_SECRET;

describe.skipIf(!rpcUrl || !networkPassphrase || !releaserSecret || seeds.length === 0)(
  "current SDK against historical deployments",
  () => {
    for (const seed of seeds) {
      it(`${seed.label}: reads and releases a legacy escrow`, async () => {
        const releaser = Keypair.fromSecret(releaserSecret!);
        const client = new EscrowClient({
          contractId: seed.contractId,
          rpcUrl,
          networkPassphrase,
        });
        const escrowId = BigInt(seed.releaseEscrowId);
        expect(await client.getStatus(escrowId)).toBe("Funded");
        await client.release({ escrowId, caller: releaser });
        expect(await client.getStatus(escrowId)).toBe("Released");
      });

      it(`${seed.label}: reads and refunds a legacy escrow`, async () => {
        const releaser = Keypair.fromSecret(releaserSecret!);
        const client = new EscrowClient({
          contractId: seed.contractId,
          rpcUrl,
          networkPassphrase,
        });
        const escrowId = BigInt(seed.refundEscrowId);
        expect(await client.getStatus(escrowId)).toBe("Funded");
        await client.refund({ escrowId, caller: releaser });
        expect(await client.getStatus(escrowId)).toBe("Refunded");
      });
    }
  },
);
