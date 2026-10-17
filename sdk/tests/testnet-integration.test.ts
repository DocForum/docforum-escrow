// Real-network integration test -- per issue #4's DoD: "at least one test
// exercising both [create_escrow/get_status] against a running/testnet
// contract instance, not just the contract's own test suite." Now also
// covers release/refund (Phase E2) and the `refund_after` deadline +
// `get_escrow` read path (Phase E4, issue #11). And split payouts +
// protocol fees (Phase E6): three-recipient splits, fee preview that
// must match the contract bit-for-bit, and the fee surface on `getEscrow`.
//
// Deliberately NOT wired into `npm test`/CI (see package.json -- this
// runs via `npm run test:integration` only): it depends on testnet
// liveness and Friendbot's funding rate limits, a materially different
// reliability profile than this org's other "integration" tests (e.g.
// docforum-core's booking test spins up its own throwaway Postgres --
// self-contained, no external service). A flaky external network
// shouldn't block every contributor's PR here.
//
// Fresh keypairs are generated and Friendbot-funded per run -- never
// commit a real secret key, even a testnet one, into a repo.
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { EscrowClient, previewPayout, splitsSumToBps } from "../src/index.js";

// Live testnet deployment of the Phase E6 contract (adds split payouts +
// protocol fee) -- see docs/testnet-deployments.md. Public contract
// addresses, not secrets.
const CONTRACT_ID = "CAHQ4J3T23WSIBBG6I6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEV5";
const NATIVE_XLM_SAC = "CDLZFC3SYYJDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

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
    // (Error::InvalidRefundAfter) -- it would let anyone refund the escrow
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

  it("creates and releases a three-recipient split escrow with a protocol fee", async () => {
    const [payer, recipientA, recipientB, recipientC, releaser, feeRecipient] = await Promise.all([
      fundedKeypair(),
      fundedKeypair(),
      fundedKeypair(),
      fundedKeypair(),
      fundedKeypair(),
      fundedKeypair(),
    ]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    // 3 ways split that sums to 10,000 bps.
    const splits = [
      { recipient: recipientA.publicKey(), bps: 5_000 },
      { recipient: recipientB.publicKey(), bps: 3_000 },
      { recipient: recipientC.publicKey(), bps: 2_000 },
    ];
    expect(splitsSumToBps(splits)).toBe(10_000);

    const amount = 1_000_000n; // 0.1 XLM
    const fee = { recipient: feeRecipient.publicKey(), bps: 100 }; // 1%

    const { escrowId } = await client.createEscrow({
      payer,
      payee: recipientA.publicKey(), // payee is ignored when splits is set
      token: NATIVE_XLM_SAC,
      amount,
      conditionRef: "sdk-integration-test-split",
      releaser: releaser.publicKey(),
      splits,
      fee,
    });

    const escrow = await client.getEscrow(escrowId);
    expect(escrow.status).toBe("Funded");
    expect(escrow.splits).toHaveLength(3);
    expect(escrow.splits).toEqual(splits);
    expect(escrowFee(escrow)).toEqual(fee);

    // Preview must match the contract's exact rounding rule.
    const preview = previewPayout(escrow);
    expect(preview.feeAmount).toBe((amount * BigInt(fee.bps)) / 10_000n + ((amount * BigInt(fee.bps)) % 10_000n === 0n ? 0n : 1n));
    const total = preview.recipients.reduce((s, r) => s + r.amount, 0n);
    expect(total + preview.feeAmount).toBe(amount);

    await client.release({ escrowId, caller: releaser });
    expect(await client.getStatus(escrowId)).toBe("Released");
  });

  it("rejects splits that do not sum to 10,000 bps or exceed the recipient cap", async () => {
    const [payer, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    await expect(
      client.createEscrow({
        payer,
        payee: payee.publicKey(),
        token: NATIVE_XLM_SAC,
        amount: 1_000_000n,
        conditionRef: "sdk-integration-test-bad-split",
        releaser: releaser.publicKey(),
        splits: [
          { recipient: payee.publicKey(), bps: 5_000 },
          { recipient: releaser.publicKey(), bps: 4_000 },
        ],
      }),
    ).rejects.toThrow();
  });
});

function escrowFee(escrow: { fee?: { recipient: string; bps: number } }) {
  return escrow.fee;
}
