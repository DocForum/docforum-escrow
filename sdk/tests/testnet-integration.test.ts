// Real-network integration test -- per issue #4's DoD: "at least one test
// exercising both [create_escrow/get_status] against a running/testnet
// contract instance, not just the contract's own test suite." Now also
// covers release/refund (Phase E2) and the `refund_after` deadline +
// `get_escrow` read path (Phase E4, issue #11), and batch create / batch
// settle (Phase E6, issue #15) including chunking across the contract's
// max batch size and resumable settlement after a partial failure.
//
// Deliberately NOT wired into `npm test`/CI (see package.json -- this
// runs via `npm run test:integration` only): it depends on testnet
// liveness and Friendbot's funding rate limits, a materially different
// reliability profile than this org's other "integration" tests (e.g.
// docforum-core's booking test spins up its own throwaway Postgres -
// self-contained, no external service). A flaky external network
// shouldn't block every contributor's PR here.
//
// Fresh keypairs are generated and Friendbot-funded per run -- never
// commit a real secret key, even a testnet one, into a repo.
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  EscrowClient,
  BatchPartialFailureError,
  type BatchCreateItem,
  type BatchSettleOperation,
} from "../src/index.js";

// Live testnet deployment of the Phase E5 contract (adds batch create and
// batch settle) -- see docs/testnet-deployments.md. Public contract
// addresses, not secrets.
const CONTRACT_ID = "CAHQ4J3T23WSIBBG6SI6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEV5";
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
    expect(txHash).toBeTruthy();

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
    expect(txHash).toBeTruthy();

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

  // Phase E6 (#15): batch create must chunk by the contract's max batch
  // size and map results back to input order. We create more items than
  // one chunk so the chunking path is exercised end-to-end.
  it("batch-creates an input larger than one chunk and maps results in order", async () => {
    const payer = await fundedKeypair();
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    // One payee / releaser per item so each escrow is independently
    // verifiable and not colluding on shared accounts.
    const itemCount = client.maxBatchSize + 3;
    const counterparties = await Promise.all(
      Array.from({ length: itemCount }, () => Promise.all([fundedKeypair(), fundedKeypair()])),
    );

    const items: BatchCreateItem[] = counterparties.map(([payee, releaser], i) => ({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: `sdk-integration-test-batch-${i}`,
      releaser: releaser.publicKey(),
    }));

    const results = await client.createEscrows(items);

    expect(results).toHaveLength(items.length);
    for (let i = 0; i < items.length; i++) {
      // Order must match the input order, chunk boundaries notwithstanding.
      expect(results[i].index).toBe(i);
      expect(results[i].ok).toBe(true);
      expect(results[i].escrowId).toBeTruthy();
      expect(await client.getStatus(results[i].escrowId!)).toBe("Funded");
    }

    // Distinct escrow ids -- no duplicates across chunks.
    const ids = new Set(results.map((r) => r.escrowId));
    expect(ids.size).toBe(items.length);
  });

  // Partial failure in chunk 2 after chunk 1 succeeded must be reported
  // precisely: the error must carry the per-item results for the entire
  // input, including the already-created escrows from chunk 1.
  it("reports a partial failure in a later chunk with per-item results", async () => {
    const payer = await fundedKeypair();
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    const itemCount = client.maxBatchSize + 2;
    const counterparties = await Promise.all(
      Array.from({ length: itemCount }, () => Promise.all([fundedKeypair(), fundedKeypair()])),
    );

    const items: BatchCreateItem[] = counterparties.map(([payee, releaser], i) => ({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: `sdk-integration-test-partial-${i}`,
      releaser: releaser.publicKey(),
    }));

    // Inject a failure in the second chunk: an amount of 0 is rejected
    // by the contract (Error::InvalidAmount). The first chunk is
    // unaffected and must have been submitted.
    const failIndex = client.maxBatchSize + 1;
    items[failIndex] = { ...items[failIndex], amount: 0n };

    let caught: unknown;
    try {
      await client.createEscrows(items);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BatchPartialFailureError);
    const error = caught as BatchPartialFailureError;
    expect(error.results).toHaveLength(items.length);
    expect(error.failedIndices).toContain(failIndex);

    // Chunk 1 succeeded: every item before the chunk boundary has an
    // escrow id and is actually Funded on-chain.
    for (let i = 0; i < client.maxBatchSize; i++) {
      expect(error.results[i].ok).toBe(true);
      expect(error.results[i].escrowId).toBeTruthy();
      expect(await client.getStatus(error.results[i].escrowId!)).toBe("Funded");
    }

    // The injected failure is reported at its exact index.
    expect(error.results[failIndex].ok).toBe(false);
    expect(error.results[failIndex].escrowId).toBeUndefined();
  });

  // Resumable mode: after a partial failure, retrying with the same
  // inputs should skip already-created escrows and only submit the
  // remaining ones. The returned results still cover the full input in
  // original order.
  it("resumes batch create after a partial failure without re-creating", async () => {
    const payer = await fundedKeypair();
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    const itemCount = client.maxBatchSize + 2;
    const counterparties = await Promise.all(
      Array.from({ length: itemCount }, () => Promise.all([fundedKeypair(), fundedKeypair()])),
    );

    const items: BatchCreateItem[] = counterparties.map(([payee, releaser], i) => ({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: `sdk-integration-test-resume-${i}`,
      releaser: releaser.publicKey(),
    }));

    const failIndex = client.maxBatchSize + 1;
    const broken = items.map((item, i) => (i === failIndex ? { ...item, amount: 0n } : item));

    let first: BatchPartialFailureError | undefined;
    try {
      await client.createEscrows(broken);
    } catch (err) {
      expect(err).toBeInstanceOf(BatchPartialFailureError);
      first = err as BatchPartialFailureError;
    }
    expect(first).toBeDefined();

    // Resume with the corrected inputs and the prior results as the
    // resume state. Already-created escrows must be skipped.
    const resumed = await client.createEscrows(items, { resumeFrom: first!.results });

    expect(resumed).toHaveLength(items.length);
    for (let i = 0; i < items.length; i++) {
      expect(resumed[i].index).toBe(i);
      expect(resumed[i].ok).toBe(true);
      expect(resumed[i].escrowId).toBeTruthy();
    }

    // The escrows created in the first attempt are preserved by id,
    // not re-created.
    for (let i = 0; i < client.maxBatchSize; i++) {
      expect(resumed[i].escrowId).toBe(first!.results[i].escrowId);
    }
  });

  // Batch settle: release and refund ops in one call, chunked by the
  // contract's max batch size, with results mapped back to input order.
  it("batch-settles more ops than one chunk and maps results in order", async () => {
    const payer = await fundedKeypair();
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    const opCount = client.maxBatchSize + 2;
    const counterparties = await Promise.all(
      Array.from({ length: opCount }, () => Promise.all([fundedKeypair(), fundedKeypair()])),
    );

    const createItems: BatchCreateItem[] = counterparties.map(([payee, releaser], i) => ({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: `sdk-integration-test-settle-${i}`,
      releaser: releaser.publicKey(),
    }));
    const created = await client.createEscrows(createItems);
    expect(created).toHaveLength(opCount);

    // Alternate release / refund so both settlement paths are covered.
    const ops: BatchSettleOperation[] = created.map((result, i) => {
      const releaser = counterparties[i][1];
      return i % 2 === 0
        ? { kind: "release", escrowId: result.escrowId!, caller: releaser }
        : { kind: "refund", escrowId: result.escrowId!, caller: releaser };
    });

    const settled = await client.settleMany(ops);
    expect(settled).toHaveLength(ops.length);

    for (let i = 0; i < ops.length; i++) {
      expect(settled[i].index).toBe(i);
      expect(settled[i].ok).toBe(true);
      const expectedStatus = i % 2 === 0 ? "Released" : "Refunded";
      expect(await client.getStatus(ops[i].escrowId)).toBe(expectedStatus);
    }
  });

  // Resumable settle: after a partial failure, retrying skips already
  // settled escrows and only submits the remaining ops.
  it("resumes batch settle after a partial failure skipping settled escrows", async () => {
    const payer = await fundedKeypair();
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    const opCount = client.maxBatchSize + 2;
    const counterparties = await Promise.all(
      Array.from({ length: opCount }, () => Promise.all([fundedKeypair(), fundedKeypair()])),
    );

    const createItems: BatchCreateItem[] = counterparties.map(([payee, releaser], i) => ({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: `sdk-integration-test-settle-resume-${i}`,
      releaser: releaser.publicKey(),
    }));
    const created = await client.createEscrows(createItems);
    expect(created).toHaveLength(opCount);

    const ops: BatchSettleOperation[] = created.map((result, i) => ({
      kind: "release",
      escrowId: result.escrowId!,
      caller: counterparties[i][1],
    }));

    // Inject a failure in the second chunk: a non-releaser caller is
    // rejected by the contract (Error::Unauthorized).
    const failIndex = client.maxBatchSize + 1;
    const broken = ops.map((op, i) =>
      (i === failIndex ? { ...op, caller: counterparties[i][0] } : op),
    );

    let first: BatchPartialFailureError | undefined;
    try {
      await client.settleMany(broken);
    } catch (err) {
      expect(err).toBeInstanceOf(BatchPartialFailureError);
      first = err as BatchPartialFailureError;
    }
    expect(first).toBeDefined();
    expect(first!.failedIndices).toContain(failIndex);

    // Chunk 1 settled cleanly.
    for (let i = 0; i < client.maxBatchSize; i++) {
      expect(first!.results[i].ok).toBe(true);
      expect(await client.getStatus(ops[i].escrowId)).toBe("Released");
    }

    // Resume with the corrected ops and the prior results as the
    // resume state. Already-settled escrows must be skipped.
    const resumed = await client.settleMany(ops, { resumeFrom: first!.results });
    expect(resumed).toHaveLength(ops.length);

    for (let i = 0; i < ops.length; i++) {
      expect(resumed[i].index).toBe(i);
      expect(resumed[i].ok).toBe(true);
      expect(await client.getStatus(ops[i].escrowId)).toBe("Released");
    }
  });
});
