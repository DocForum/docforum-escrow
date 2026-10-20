// Real-network integration test — per issue #4's DoD: "at least one test
// exercising both [create_escrow/get_status] against a running/testnet
// contract instance, not just the contract's own test suite." Now also
// covers release/refund (Phase E2), the `refund_after` deadline +
// `get_escrow` read path (Phase E4, issue #11), and factory deployment +
// instance discovery (Phase E6).
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
import { EscrowClient, FactoryClient, predictInstanceAddress } from "../src/index.js";

// Live testnet deployment of the Phase E4 contract (adds `refund_after`
// timeout refund + `get_escrow`) — see docs/testnet-deployments.md.
// Public contract addresses, not secrets.
const CONTRACT_ID = "CAHQ4J3T23WSIBBG6SI6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEV5";
const NATIVE_XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
// Live testnet deployment of the Phase E5 escrow factory contract — see
// docs/testnet-deployments.md. Public contract address, not a secret.
const FACTORY_ID = "CBXWQZ4QZ4QZ4QZ4QZ4QZ4QZ4QZ4QZ4QZ4QZ4QZ4QZ4QZ4QZ4QZ4Q";

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

  it("settles a 2-of-3 quorum escrow with two approvers", async () => {
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

  it("predicts the instance address offline and matches on-chain deployment", async () => {
    const [integrator] = await Promise.all([fundedKeypair()]);
    const factory = new FactoryClient({ contractId: FACTORY_ID });

    // Deterministic salt derived from the integrator so the test is
    // reproducible across runs without colliding with prior deployments.
    const salt = BigInt("0x" + Buffer.from(integrator.publicKey()).toString("hex").slice(0, 16));

    // Computed entirely offline — no network call.
    const predicted = predictInstanceAddress(FACTORY_ID, salt);
    expect(predicted).toMatch(/^C[A-Z2-7]{55}$/);

    const { instanceId, txHash } = await factory.deployInstance({
      integrator,
      salt,
      config: { token: NATIVE_XLM_SAC },
    });
    expect(txHash).toBeTruthy();

    // The reviewer's key check: predicted address must equal the actual
    // deployed instance address exactly.
    expect(instanceId).toBe(predicted);

    // Discovery: getInstance returns the same address for the integrator.
    expect(await factory.getInstance(integrator.publicKey())).toBe(predicted);
  });

  it("handles 'already deployed' gracefully", async () => {
    const [integrator] = await Promise.all([fundedKeypair()]);
    const factory = new FactoryClient({ contractId: FACTORY_ID });
    const salt = BigInt("0x" + Buffer.from(integrator.publicKey()).toString("hex").slice(0, 16));

    const first = await factory.deployInstance({
      integrator,
      salt,
      config: { token: NATIVE_XLM_SAC },
    });

    // Re-deploying the same (integrator, salt) must not throw; it should
    // resolve to the already-deployed instance.
    const second = await factory.deployInstance({
      integrator,
      salt,
      config: { token: NATIVE_XLM_SAC },
    });
    expect(second.instanceId).toBe(first.instanceId);
    expect(second.alreadyDeployed).toBe(true);
  });

  it("runs a full lifecycle on a factory-deployed instance via forIntegrator", async () => {
    const [integrator, payer, payee, releaser] = await Promise.all([
      fundedKeypair(), fundedKeypair(), fundedKeypair(), fundedKeypair(),
    ]);
    const factory = new FactoryClient({ contractId: FACTORY_ID });
    const salt = BigInt("0x" + Buffer.from(integrator.publicKey()).toString("hex").slice(0, 16));

    const predicted = predictInstanceAddress(FACTORY_ID, salt);
    const { instanceId } = await factory.deployInstance({
      integrator,
      salt,
      config: { token: NATIVE_XLM_SAC },
    });
    expect(instanceId).toBe(predicted);

    // Construct an EscrowClient bound to the integrator's own instance.
    const client = await EscrowClient.forIntegrator(factory, integrator.publicKey());
    expect(client.contractId).toBe(predicted);

    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-factory-lifecycle",
      releaser: releaser.publicKey(),
    });
    expect(await client.getStatus(escrowId)).toBe("Funded");

    await client.release({ escrowId, caller: releaser });
    expect(await client.getStatus(escrowId)).toBe("Released");
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
});
