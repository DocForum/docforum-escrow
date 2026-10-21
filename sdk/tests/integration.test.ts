// Real-network integration test — per issue #4's DoD: "at least one test
// exercising both [create_escrow/get_status] against a running/testnet
// contract instance, not just the contract's own test suite." Now also
// covers release/refund (Phase E2) and the `refund_after` deadline +
// `get_escrow` read path (Phase E4, issue #11).
//
// The suite is parameterised by network (tests/integration-network.ts):
//   npm run test:integration        → live testnet (default, unchanged)
//   npm run test:integration:local  → a local `stellar/quickstart` network
// The local run is what CI executes on every PR, so a regression in a
// network call fails the PR instead of waiting for the nightly soak.
//
// Fresh keypairs are generated and Friendbot-funded per run — never
// commit a real secret key, even a testnet or local one, into a repo.
import { describe, expect, it } from "vitest";
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Operation,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { EscrowClient } from "../src/index.js";
import { fundedKeypair, network, networkNow } from "./integration-network.js";

function newClient(): EscrowClient {
  return new EscrowClient({
    contractId: network.contractId,
    rpcUrl: network.rpcUrl,
    networkPassphrase: network.networkPassphrase,
    allowHttp: network.allowHttp,
  });
}

/**
 * Wait until the network's ledger clock has moved past `deadline`. The
 * contract compares against the ledger timestamp, not wall-clock time, so
 * sleeping for a fixed duration is not enough (and would drift on a local
 * network whose genesis time differs from the runner's clock).
 */
async function waitForLedgerAfter(deadline: bigint): Promise<void> {
  const started = Date.now();
  for (;;) {
    if ((await networkNow()) > Number(deadline) + 6) return;
    if (Date.now() - started > 120_000) {
      throw new Error(`Ledger clock did not pass ${deadline} within 120s.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

describe(`EscrowClient against ${network.label}`, () => {
  it("creates, funds, and releases an escrow end-to-end", async () => {
    const [payer, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = newClient();

    const { escrowId, txHash } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: network.nativeTokenId,
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
    const client = newClient();
    const releaseEscrow = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: network.nativeTokenId,
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
      token: network.nativeTokenId,
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
  // entry points; a local run deploys the current WASM, so it exercises
  // these for real (see integration-network.ts).
  it.skipIf(!network.quorumSupported)("settles a 2-of-3 quorum escrow with two approvers", async () => {
    const [payer, payee, first, second, third] = await Promise.all([
      fundedKeypair(), fundedKeypair(), fundedKeypair(), fundedKeypair(), fundedKeypair(),
    ]);
    const client = newClient();
    const releasers = [first.publicKey(), second.publicKey(), third.publicKey()];

    const { escrowId } = await client.createQuorumEscrow({
      payer,
      payee: payee.publicKey(),
      token: network.nativeTokenId,
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
    const client = newClient();

    const { escrowId, txHash } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: network.nativeTokenId,
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
    const client = newClient();

    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: network.nativeTokenId,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-unauthorized",
      releaser: releaser.publicKey(),
    });

    await expect(client.release({ escrowId, caller: payee })).rejects.toThrow();
    expect(await client.getStatus(escrowId)).toBe("Funded");
  });

  it("surfaces refundAfter via getEscrow, and rejects a deadline already in the past", async () => {
    const [payer, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = newClient();

    // Relative to the network's ledger clock, not the runner's: on a local
    // network the genesis time can differ from wall-clock time.
    const now = await networkNow();
    // Far enough in the future to survive the round trip: 1 hour.
    const refundAfter = BigInt(now + 3_600);
    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: network.nativeTokenId,
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
    const past = BigInt(now - 60);
    await expect(
      client.createEscrow({
        payer,
        payee: payee.publicKey(),
        token: network.nativeTokenId,
        amount: 1_000_000n,
        conditionRef: "sdk-integration-test-past-deadline",
        releaser: releaser.publicKey(),
        refundAfter: past,
      }),
    ).rejects.toThrow();
  });

  it("reports no deadline for an escrow created without refundAfter", async () => {
    const [payer, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = newClient();

    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: network.nativeTokenId,
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
    const client = newClient();
    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: network.nativeTokenId,
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
      networkPassphrase: network.networkPassphrase,
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
    const client = newClient();
    const refundAfter = BigInt((await networkNow()) + 25);
    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: network.nativeTokenId,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-timeout-refund",
      releaser: releaser.publicKey(),
      refundAfter,
    });

    // The contract checks the ledger timestamp, so wait on the network's
    // clock rather than assuming wall-clock time matches it.
    await waitForLedgerAfter(refundAfter);
    await client.refund({ escrowId, caller: stranger });
    expect(await client.getStatus(escrowId)).toBe("Refunded");
  }, 150_000);
});
