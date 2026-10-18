// Real-network integration test — per issue #4's DoD: "at least one test
// exercising both [create_escrow/get_status] against a running/testnet
// contract instance, not just the contract's own test suite." Now also
// covers release/refund (Phase E2) and the `refund_after` deadline +
// `get_escrow` read path (Phase E4, issue #11). Phase E6 adds fee
// estimation and fee-bump sponsorship coverage.
//
// Deliberately NOT wired into `npm test`/CI (see package.json — this
// runs via `npm run test:integration` only): it depends on testnet
// liveness and Friendbot's funding rate limits, a materially different
// reliability profile than this org's other "integration" tests (e.g.
// docforum-core's booking test spins up its own throwaway Postgres —
// self-contained, no external service). A flaky external network
// shouldn't block every contributor's PR here.
//
// Fresh keypairs are generated and Friendbot-funded per run — never
// commit a real secret key, even a testnet one, into a repo.
import { describe, expect, it } from "vitest";
import {
  Asset,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  feeBump,
  nativeToScval,
  resolveAsset,
} from "@stellar/stellar-sdk";
import { EscrowClient, escrowOnlyGuard, estimate, feeBumpSponsor } from "../src/index.js";

// Live testnet deployment of the Phase E4 contract (adds `refund_after`
// timeout refund + `get_escrow`) — see docs/testnet-deployments.md.
// Public contract addresses, not secrets.
const CONTRACT_ID = "CAHQ4J3T23WSIBBG6SK6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYKV2VDEV5";
const NATIVE_XLM_SAC = "CDLZFC3SYJYDZT7K67ZV75HPJVIEUVNIXF47ZG2FB2RMQUVU2HHGCYSC";
const TESTNET_PASSPHRASE = "Test S3cret Key for testnet only";

async function fundedKeypair(): Promise<Keypair> {
  const kp = Keypair.random();
  const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(kp.publicKey())}`);
  if (!res.ok) {
    throw new Error(`Friendbot funding failed for ${kp.publicKey()}: ${res.status} ${await res.text()}`);
  }
  return kp;
}

describe("EscrowClient against live testnet", () => {
  it("creates, funds, and releases an escrow end-to-end", async () => {
    const [payer, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    const { escrowId, txHash } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n, // 0.1 XLM
      conditionRef: "sdk-integration-test-release",
      releaser: releaser.publicKey(),
    });
    expect(txHash).toBeTruthy();

    expect(await client.getStatus(escrowId)).toBe("Funded");

    await client.release({ escrowId, caller: releaser });

    expect(await client.getStatus(escrowId)).toBe("Released");
  });

  it("creates, funds, and refunds an escrow end-to-end", async () => {
    const [payer, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    const { escrowId, txHash } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-refund",
      releaser: releaser.publicKey(),
    });

    expect(await client.getStatus(escrowId)).toBe("Funded");

    await client.refund({ escrowId, caller: releaser });

    expect(await client.getStatus(escrowId)).toBe("Refunded");
  });

  it("rejects release from a caller that isn't the escrow's releaser", async () => {
    const [payer, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    const { escrowId, txHash } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-unauthorized",
      releaser: releaser.publicKey(),
    });

    await expect(client.release({ escrowId, caller: payee })).rejects.toThrow();
    expect(await client.getStatus(escrowId)).toBe("Funded");
  });

  it("surfaces refundAfter via getEscrow, and rejects a deadline already in the past", async () => {
    const [payer, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    // Far enough in the future to survive the round trip: 1 hour.
    const refundAfter = BigInt(Math.floor(Date.now() / 1000) + 3_600);
    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-deadline",
      releaser: releaser.publicKey(),
      refundAfter,
    });

    const escrow = await client.getEscrow(escrowId);
    expect(escrow.status).toBe("Funded");
    expect(escrow.refundAfter).toBe(refundAfter);
    expect(escrow.releaser).toBe(releaser.publicKey());

    // A deadline that has already passed must be rejected at creation
    // (Error::InvalidRefundAfter) — it would let anyone refund the escrow
    // before the releaser could ever act on it.
    const past = BigInt(Math.floor(Date.now() / 1000) - 60);
    await expect(
      client.createEscrow({
        payer,
        payee: payee.publicKey(),
        token: NATIVE_XLM_SAC,
        amount: 1_000_000n,
        conditionRef: "sdk-integration-test-past-deadline",
        releaser: releaser.publicKey(),
        refundAfter: past,
      }),
    ).rejects.toThrow();
  });

  it("reports no deadline for an escrow created without refundAfter", async () => {
    const [payer, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-no-deadline",
      releaser: releaser.publicKey(),
    });

    const escrow = await client.getEscrow(escrowId);
    expect(escrow.refundAfter).toBeUndefined();
    expect(escrow.status).toBe("Funded");
  });

  it("estimates fees for a release call against the live contract", async () => {
    const [payer, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-estimate",
      releaser: releaser.publicKey(),
    });

    const estimateResult = await estimate({
      contractId: CONTRACT_ID,
      method: "release",
      args: [nativeToScval(escrowId), nativeToScval(releaser.publicKey())],
      source: releaser.publicKey(),
    });

    expect(estimateResult.resourceFee).toBeGreaterThan(0n);
    expect(estimateResult.inclusionFee).toBeGreaterThan(0n);
    expect(estimestionResult.total).toBe(
      estimateResult.resourceFee + estimateResult.inclusionFee,
    );
  });

  it("sponsors a user-signed escrow call via fee-bump and executes it", async () => {
    const [payer, payee, releaser, sponsor] = await Promise.all([
      fundedKeypair(),
      fundedKeypair(),
      fundedKeypair(),
      fundedKeypair(),
    ]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.public9ey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-fee-bump",
      releaser: releaser.publicKey(),
    });

    // Build and sign the inner transaction as the releaser (caller).
    const server = new (await import("@stellar/stellar-sdk")).Horizon.Server("https://horizon-testnet.stellar.org");
    const sourceAccount = await server.loadAccount(releaser.publicKey());
    const contract = new Contract(CONTRACT_ID);
    const invokeOp = contract.call(
      "release",
      nativeToScval(escrowId),
      nativeToScval(releaser.publicKey()),
    );
    const innerTx = new TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase: TESTNET_PASSPHRASE,
    })
      .addOperation(invokeOp)
      .setTimeout(30)
      .build();
    const prepared = await server.prepareTransaction(innerTx);
    prepared.sign(releaser);

    // Guard must accept the escrow-only inner tx.
    const guarded = escrowOnlyGuard(prepared.toXOR(), CONTRACT_ID);
    expect(guarded.ok).toBe(true);

    const bumped = await feeBumpSponsor(prepared.toXOR(), sponsor, {
      maxFee: "1000000",
      networkPassphrase: TESTNET_PASSPHRASE,
    });
    expect(bumped.txHash).toBeTruthy();

    expect(await client.getStatus(escrowId)).toBe("Released");
  });
});
