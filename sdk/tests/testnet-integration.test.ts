// Real-network integration test — per issue #4's DoD: "at least one test
// exercising both [create_escrow/get_status] against a running/testnet
// contract instance, not just the contract's own test suite." Now also
// covers release/refund (Phase E2) and the `refund_after` deadline +
// `get_escrow` read path (Phase E4, issue #11).
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
  Account,
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { EscrowClient } from "../src/index.js";

// Live testnet deployment of the Phase E4 contract (adds `refund_after`
// timeout refund + `get_escrow`) — see docs/testnet-deployments.md.
// Public contract addresses, not secrets.
const CONTRACT_ID = "CAHQ4J3T23WSIBBG6SI6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEV5";
const NATIVE_XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

async function fundedKeypair(): Promise<Keypair> {
  const kp = Keypair.random();
  const url = `https://friendbot.stellar.org?addr=${encodeURIComponent(kp.publicKey())}`;
  // Friendbot is rate-limited independently of the test assertions. Retry
  // only transient funding/network failures; transaction and assertion
  // failures are never retried.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return kp;
      const detail = await res.text();
      if (res.status < 500 && res.status !== 429) {
        throw new Error(`Friendbot funding failed: ${res.status} ${detail}`);
      }
      if (attempt === 4) throw new Error(`Friendbot funding failed after retries: ${res.status} ${detail}`);
    } catch (error) {
      if (attempt === 4 || (error instanceof Error && error.message.startsWith("Friendbot funding failed:"))) {
        throw new Error(`Friendbot funding failed for ${kp.publicKey()}: ${String(error)}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
  }
  throw new Error("Friendbot funding failed after retries");
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

  it("lets a separate relayer submit releaser-authorized release and refund", async () => {
    const [payer, payee, releaser, relayer] = await Promise.all([
      fundedKeypair(), fundedKeypair(), fundedKeypair(), fundedKeypair(),
    ]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const releaseEscrow = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-relayed-release",
      releaser: releaser.publicKey(),
    });
    const releaseAuth = await client.authorizeRelease({
      escrowId: releaseEscrow.escrowId,
      releaser,
      relayer,
    });
    expect(releaseAuth.expiresAtLedger).toBeGreaterThan(0);
    await client.submitRelayed("release", releaseAuth, relayer);
    expect(await client.getStatus(releaseEscrow.escrowId)).toBe("Released");

    const refundEscrow = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-relayed-refund",
      releaser: releaser.publicKey(),
    });
    const refundAuth = await client.authorizeRefund({
      escrowId: refundEscrow.escrowId,
      releaser,
      relayer,
    });
    await client.submitRelayed("refund", refundAuth, relayer);
    expect(await client.getStatus(refundEscrow.escrowId)).toBe("Refunded");
  });

  // The documented live testnet deployment predates the quorum contract
  // entry points. Enable after a quorum-capable deployment is recorded.
  it.skipIf(process.env.TESTNET_QUORUM_SUPPORTED !== "true")("settles a 2-of-3 quorum escrow with two approvers", async () => {
    const [payer, payee, first, second, third] = await Promise.all([
      fundedKeypair(), fundedKeypair(), fundedKeypair(), fundedKeypair(), fundedKeypair(),
    ]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const releasers = [first.publicKey(), second.publicKey(), third.publicKey()];

    const { escrowId } = await client.createQuorumEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-quorum",
      releasers,
      threshold: 2,
    });
    const escrow = await client.getEscrow(escrowId);
    expect(escrow.threshold).toBe(2);
    expect(escrow.releasers).toEqual(releasers);

    // One member cannot settle alone; two can.
    await expect(
      client.release({ escrowId, caller: first }),
    ).rejects.toThrow();
    await client.releaseWithApprovals({ escrowId, approvers: [first, third] });
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
    expect(escrow.releasers).toEqual([releaser.publicKey()]);
    expect(escrow.threshold).toBe(1);

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

  it("estimates a live call's fee and fee-bumps a signed envelope under the cap", async () => {
    const [payer, payee, releaser, sponsor] = await Promise.all([
      fundedKeypair(), fundedKeypair(), fundedKeypair(), fundedKeypair(),
    ]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-fees",
      releaser: releaser.publicKey(),
    });

    // Simulate the release the releaser is about to send — the estimate must be
    // internally consistent and non-zero.
    const estimate = await client.estimate({
      source: payer,
      method: "release",
      args: [nativeToScVal(escrowId, { type: "u64" }), new Address(releaser.publicKey()).toScVal()],
    });
    expect(estimate.minResourceFee).toBeGreaterThan(0n);
    expect(estimate.resourceFee).toBeGreaterThanOrEqual(estimate.minResourceFee);
    expect(estimate.total).toBe(estimate.resourceFee + estimate.inclusionFee);

    // A plain payment is not an escrow call: the guard must refuse it, while
    // the fee-bump helper still wraps it for an explicitly willing sponsor.
    const payment = new TransactionBuilder(new Account(payer.publicKey(), "1"), {
      fee: BASE_FEE,
      networkPassphrase: "Test SDF Network ; September 2015",
    })
      .addOperation(
        Operation.payment({ destination: payee.publicKey(), asset: Asset.native(), amount: "1" }),
      )
      .setTimeout(30)
      .build();
    payment.sign(payer);

    const guard = client.guardSponsorship(payment.toXDR());
    expect(guard.ok).toBe(false);
    expect(guard.reasons[0]).toContain("is not a contract invocation");

    const bumped = client.feeBump(payment.toXDR(), sponsor, { maxFee: 1_000n });
    expect(bumped.fee).toBeLessThanOrEqual(1_000n);
    expect(bumped.innerTxHash).toBe(payment.hash().toString("hex"));
  });

  it("allows a fresh stranger to refund after a short timeout", async () => {
    const [payer, payee, releaser, stranger] = await Promise.all([
      fundedKeypair(), fundedKeypair(), fundedKeypair(), fundedKeypair(),
    ]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const refundAfter = BigInt(Math.floor(Date.now() / 1000) + 25);
    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-timeout-refund",
      releaser: releaser.publicKey(),
      refundAfter,
    });

    // Wait for the wall clock to pass the deadline; the contract checks the
    // ledger timestamp, so allow one more ledger close before submitting.
    while (Date.now() / 1000 <= Number(refundAfter) + 6) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await client.refund({ escrowId, caller: stranger });
    expect(await client.getStatus(escrowId)).toBe("Refunded");
  }, 90_000);
});