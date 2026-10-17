// Real-network integration test — per issue #4's DoD: "at least one test
// exercising both [create_escrow/get_status] against a running/testnet
// contract instance, not just the contract's own test suite." Now also
// covers release/refund (Phase E2), the `refund_after` deadline +
// `get_escrow` read path (Phase E4, issue #11), and dispute/arbiter
// support including split settlement (Phase E6).
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
import { Keypair } from "@stellar/stellar-sdk";
import { EscrowClient } from "../src/index.js";

// Live testnet deployment of the Phase E6 contract (adds dispute
// raise/resolve + split settlement) — see docs/testnet-deployments.md.
// Public contract addresses, not secrets.
const CONTRACT_ID = "CAHP4J3T23WSIBBG6SK6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2WADEV5";
const NATIVE_XLM_SAC = "CDLZFC3SYJYDZT7K67ZV75HPJVIEEVNIXF47ZG2FB2RMQQOVU2HHGCYSC";

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

  it("creates a disputed escrow and resolves it with a split settlement by the arbiter", async () => {
    const [payer, payee, releaser, arbiter] = await Promise.all([
      fundedKeypair(),
      fundedKeypair(),
      fundedKeypair(),
      fundedKeypair(),
    ]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-dispute",
      releaser: releaser.publicKey(),
      arbiter: arbiter.publicKey(),
    });

    expect(await client.getStatus(escrowId)).toBe("Funded");

    // Payee raises the dispute.
    await client.raiseDispute({ escrowId, caller: payee });
    expect(await client.getStatus(escrowId)).toBe("Disputed");

    // Arbiter resolves with a split: 60% / 40%.
    const payeeBps = 6_000;
    const payerBps = 4_000;
    await client.resolveDispute({
      escrowId,
      caller: arbiter,
      payerBps,
      payeeBps,
    });

    expect(await client.getStatus(escrowId)).toBe("Resolved");
  });

  it("rejects raiseDispute from an address that is not a party", async () => {
    const [payer, payee, releaser, arbiter, outsider] = await Promise.all([
      fundedKeypair(),
      fundedKeypair(),
      fundedKeypair(),
      fundedKeypair(),
      fundedKeypair(),
    ]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-dispute-unauthorized",
      releaser: releaser.publicKey(),
      arbiter: arbiter.publicKey(),
    });

    await expect(client.raiseDispute({ escrowId, caller: outsider })).rejects.toThrow();
    expect(await client.getStatus(escrowId)).toBe("Funded");
  });

  it("rejects resolveDispute from a caller that isn't the arbiter", async () => {
    const [payer, payee, releaser, arbiter] = await Promise.all([
      fundedKeypair(),
      fundedKeypair(),
      fundedKeypair(),
      fundedKeypair(),
    ]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-resolve-unauthorized",
      releaser: releaser.publicKey(),
      arbiter: arbiter.publicKey(),
    });

    await client.raiseDispute({ escrowId, caller: payee });
    expect(await client.getStatus(escrowId)).toBe("Disputed");

    await expect(
      client.resolveDispute({
        escrowId,
        caller: releaser,
        payerBps: 5_000,
        payeeBps: 5_000,
      }),
    ).rejects.toThrow();
    expect(await client.getStatus(escrowId)).toBe("Disputed");
  });

  it("settles a disputed escrow via the settle helper", async () => {
    const [payer, payee, releaser, arbiter] = await Promise.all([
      fundedKeypair(),
      fundedKeypair(),
      fundedKeypair(),
      fundedKeypair(),
    ]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-settle",
      releaser: releaser.publicKey(),
      arbiter: arbiter.publicKey(),
    });

    await client.raiseDispute({ escrowId, caller: payer });
    expect(await client.getStatus(escrowId)).toBe("Disputed");

    await client.resolveDispute({
      escrowId,
      caller: arbiter,
      payerBps: 2_500,
      payeeBps: 7_500,
    });

    expect(await client.getStatus(escrowId)).toBe("Resolved");
  });
})
