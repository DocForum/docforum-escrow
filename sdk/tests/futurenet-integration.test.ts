import { beforeAll, describe, expect, it } from "vitest";
import { Asset, Keypair, xdr } from "@stellar/stellar-sdk";
import { Durability, Server as RpcServer } from "@stellar/stellar-sdk/rpc";
import { EscrowClient } from "../src/index.js";

/**
 * Futurenet integration suite (Phase E7).
 *
 * Run only by the `Futurenet compatibility checks` workflow, against a
 * contract deployed to Stellar futurenet from that same run. It is not part
 * of `test`, `test:integration` or `test:offline`, and must never block PRs:
 *
 *   FUTURENET_CONTRACT_ID=<id> npm run test:futurenet
 *
 * Futurenet is reset often, so the suite is deliberately tolerant of missing
 * state. If `FUTURENET_CONTRACT_ID` is unset, every test is skipped. If the
 * contract is not on the ledger (network was reset mid-run), the on-chain
 * tests skip with a warning instead of failing — that is a property of the
 * network, not a compatibility regression, and the workflow reports it.
 *
 * The network passphrase comes from futurenet's own RPC (`getNetwork`) rather
 * than a hardcoded constant, so this keeps working when futurenet is
 * re-genesis'd.
 */
const RPC_URL = process.env.STELLAR_RPC ?? "https://rpc-futurenet.stellar.org";
const CONTRACT_ID = process.env.FUTURENET_CONTRACT_ID ?? "";

// Friendbot funds free futurenet accounts per run. Never commit a real
// secret key, even a testnet/futurenet one.
async function fundedKeypair(): Promise<Keypair> {
  const keypair = Keypair.random();
  const url = `https://friendbot-futurenet.stellar.org/?addr=${encodeURIComponent(keypair.publicKey())}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Futurenet Friendbot failed for ${keypair.publicKey()}: ${res.status} ${await res.text()}`);
  }
  return keypair;
}

describe.skipIf(CONTRACT_ID === "")("Futurenet compatibility (Phase E7)", () => {
  const server = new RpcServer(RPC_URL);
  let passphrase = "";
  let protocolVersion: string | undefined;
  let contractOnLedger = false;

  beforeAll(async () => {
    const network = await server.getNetwork();
    passphrase = network.passphrase;
    protocolVersion = network.protocolVersion;

    const expected = process.env.STELLAR_NETWORK_PASSPHRASE;
    if (expected && expected !== passphrase) {
      console.warn(
        `STELLAR_NETWORK_PASSPHRASE is "${expected}" but futurenet RPC reports "${passphrase}"; using RPC.`,
      );
    }

    try {
      await server.getContractData(
        CONTRACT_ID,
        xdr.ScVal.scvLedgerKeyContractInstance(),
        Durability.Persistent,
      );
      contractOnLedger = true;
    } catch {
      console.warn(
        `Futurenet contract ${CONTRACT_ID} not found (protocol ${protocolVersion}) -- the network may have been reset. Skipping on-chain checks.`,
      );
    }
  });

  it("reports a usable futurenet protocol and passphrase", () => {
    console.log(`futurenet protocol ${protocolVersion ?? "unknown"}, passphrase "${passphrase}"`);
    expect(passphrase.length).toBeGreaterThan(0);
  });

  it("has the deployed contract instance on the futurenet ledger", (ctx) => {
    if (!contractOnLedger) ctx.skip();
    expect(contractOnLedger).toBe(true);
  });

  it("creates, funds and releases an escrow on futurenet", async (ctx) => {
    if (!contractOnLedger) ctx.skip();

    const [payer, payee, releaser] = await Promise.all([
      fundedKeypair(),
      fundedKeypair(),
      fundedKeypair(),
    ]);
    const client = new EscrowClient({
      contractId: CONTRACT_ID,
      rpcUrl: RPC_URL,
      networkPassphrase: passphrase,
    });

    const { escrowId, txHash } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      // The native XLM SAC address is derived from the network passphrase, so
      // this stays correct if futurenet is re-genesis'd.
      token: Asset.native().contractId(passphrase),
      amount: 1_000_000n, // 0.1 XLM
      conditionRef: "futurenet-compatibility-check",
      releaser: releaser.publicKey(),
    });
    expect(txHash).toBeTruthy();
    expect(await client.getStatus(escrowId)).toBe("Funded");

    await client.release({ escrowId, caller: releaser });
    expect(await client.getStatus(escrowId)).toBe("Released");
  }, 180_000);
});
