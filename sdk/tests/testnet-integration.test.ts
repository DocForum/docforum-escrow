// Real-network integration test — per issue #4's DoD: "at least one test
// exercising both [create_escrow/get_status] against a running/testnet
// contract instance, not just the contract's own test suite." Now also
// covers release/refund (Phase E2) and the `refund_after` deadline +
// `get_escrow` read path (Phase E4, issue #11). Phase E6 adds the
// attestation signing + release-with-attestation flow, exercised here
// with an offline attester keypair.
//
// Deliberately NOT wired into `npm test`/CI (see package.json — this
// runs via `npm run test:integration` only): it depends on testnet liveness and Friendbot's funding rate limits, a materially different
// reliability profile than this org's other "integration" tests (e.g.
// docforum-core's booking test spins up its own throwaway Postgres —
// self-contained, no external service). A flaky external network
// shouldn't block every contributor's PR here.
//
// Fresh keypairs are generated and Friendbot-funded per run — never
// commit a real secret key, even a testnet one, into a repo.
import { describe, expect, it } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import {
  EscrowClient,
  buildAttestationMessage,
  signAttestation,
  type AttestationAction,
} from "../src/index.js";


// Live testnet deployment of the Phase E4 contract (adds `refund_after`
// timeout refund + `get_escrow`) — see docs/testnet-deployments.md.
// Public contract addresses, not secrets.
const CONTRACT_ID = "CAHQ4J3T23WSIBBG6SK6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEV5";
const NATIVE_XLM_SAC = "CDLZFC3SJJYZDT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

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

    const { escrowId } = await client.createEscrow({
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

  it("releases an escrow via an attestation signed by an offline attester key", async () => {
    const [payer, payee] = await Promise.all([fundedKeypair(), fundedKeypair()]);
    // The attester key is generated locally and never funded — it only
    // signs the domain-separated message offline; it never submits a tx.
    const attester = Keypair.random();
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-attestation",
      releaser: attester.publicKey(),
    });

    expect(await client.getStatus(escrowId)).toBe("Funded");

    const action: AttestationAction = "Release";
    const message = buildAttestationMessage({
      contractId: CONTRACT_ID,
      networkPassphrase: Networks.TESTNET.passphrase(),
      escrowId,
      action,
    });
    const signature = await signAttestation(message, attester);

    await client.releaseWithAttestation({ escrowId, signature });

    expect(await client.getStatus(escrowId)).toBe("Released");
  });

  it("rejects an attestation signed for the wrong network", async () => {
    const [payer, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-wrong-network",
      releaser: releaser.publicKey(),
    });

    // Sign for mainnet's passphrase but submit against testnet — the
    // contract must reject it, so a testnet signature can't be replayed
    // on mainnet (or vice versa).
    const message = buildAttestationMessage({
      contractId: CONTRACT_ID,
      networkPassphrase: Networks.PUBLIC.passphrase(),
      escrowId,
      action: "Release",
    });
    const signature = await signAttestation(message, releaser);

    await expect(client.releaseWithAttestation({ escrowId, signature })).rejects.toThrow();
    expect(await client.getStatus(escrowId)).toBe("Funded");
  });

  it("rejects release from a caller that isn't the escrow's releaser", async () => {
    const [payer, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    const { escrowId } = await client.createEscrow({
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
    const refundAfter = BigInt(Math.floor(Date.now() / 1000 + 3_300));
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
    const past = BigInt(Math.floor(Date.now() / 1000 - 60));
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
});
