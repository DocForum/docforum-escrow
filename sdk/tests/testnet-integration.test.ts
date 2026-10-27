// Real-network integration test -- per issue #4's DoD: "at least one test
// exercising both [create_escrow/get_status] against a running/testnet
// contract instance, not just the contract's own test suite." Now also
// covers release/refund (Phase E2) and the `refund_after` deadline +
// `get_escrow` read path (Phase E4, issue #11). Adds Phase E6 factory
// deployment + instance discovery coverage (deterministic address
// prediction must match the on-chain deployment).
//
// Deliberately NOT wired into `npm test`/CI (see package.json -- thit
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
import {
  EscrowClient,
  EscrowPreconditionError,
  FactoryClient,
  PreparedTransactionExpiredError,
  SignedTransactionMismatchError,
  predictInstanceAddress,
} from "../src/index.js";

// Current upstream-main testnet deployment, including BalanceMismatch
// and opt-in payee acceptance -- see docs/testnet-deployments.md.
// Public contract addresses, not secrets.
const CONTRACT_ID = "CAFI5QOTNLK5OIHEHGGQ7B22RN5IUOFGKKEID2OQCZSCJAQS4FLSS2DR";
const NATIVE_XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
// Phase E6 factory contract deployed on testnet alongside the
// instance contract above. Overridable via env for forks that deploy
// their own factory. Public contract address, not a secret.
// A factory contract id must be provided to run the live factory suite. The
// fallback is only a syntactically valid contract id so the file still loads.
const FACTORY_ID = process.env.TESTNET_FACTORY_ID ?? "CBCYSOQ3HKYQDHLSHTFNIAA7X2NUGJVYOCN24DCVT46VG4YI6DMNARMD";
// The repo ships no factory contract, so the live factory suites only run when
// a factory is actually deployed and TESTNET_FACTORY_ID points at it.
const describeFactory = process.env.TESTNET_FACTORY_ID ? describe : describe.skip;

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

  // This extra quorum case is opt-in to limit Friendbot funding during
  // ordinary integration runs; the current contract supports quorum.
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

  // Issue #84: lifecycle amendments.
  it("tops up a funded escrow and releases the new total", async () => {
    const [payer, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-top-up",
      releaser: releaser.publicKey(),
    });

    await client.topUp({ escrowId, payer, amount: 500_000n });
    expect((await client.getEscrow(escrowId)).amount).toBe(1_500_000n);

    await expect(client.topUp({ escrowId, payer: payee, amount: 1n })).rejects.toThrow(EscrowPreconditionError);
    await client.release({ escrowId, caller: releaser });
    expect(await client.getStatus(escrowId)).toBe("Released");
  });

  it("records payee acceptance, after which the payer can no longer cancel", async () => {
    const [payer, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-accept",
      releaser: releaser.publicKey(),
      requiresAcceptance: true,
    });
    expect((await client.getEscrow(escrowId)).requiresAcceptance).toBe(true);

    await client.accept({ escrowId, payee });
    expect((await client.getEscrow(escrowId)).acceptedAt).toBeGreaterThan(0n);
    await expect(client.cancel({ escrowId, payer })).rejects.toMatchObject({ code: "AlreadyAccepted" });
    expect(await client.getStatus(escrowId)).toBe("Funded");
  });

  // `cancel` is not on the shared testnet deployment yet (see
  // ARCHITECTURE_ESSENTIALS.md); set TESTNET_HAS_CANCEL=1 once it is.
  it.skipIf(!process.env.TESTNET_HAS_CANCEL)("lets the payer cancel before the payee accepts", async () => {
    const [payer, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-cancel",
      releaser: releaser.publicKey(),
      requiresAcceptance: true,
    });

    await client.cancel({ escrowId, payer });
    expect(await client.getStatus(escrowId)).toBe("Cancelled");
    await expect(client.accept({ escrowId, payee })).rejects.toMatchObject({ code: "NotFunded" });
  });

  it("runs prepare → sign → submit with the signer and submitter in separate clients", async () => {
    const [payer, payee, releaser, relayer] = await Promise.all([
      fundedKeypair(), fundedKeypair(), fundedKeypair(), fundedKeypair(),
    ]);
    const setup = new EscrowClient({ contractId: CONTRACT_ID });
    const { escrowId } = await setup.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-two-party",
      releaser: releaser.publicKey(),
    });

    // Each step uses its own client and passes only JSON, as separate processes would.
    const prepared = await new EscrowClient({ contractId: CONTRACT_ID }).prepareLifecycleCall({
      call: { method: "top_up", escrowId, payer: payer.publicKey(), amount: 250_000n },
      source: relayer.publicKey(),
    });
    expect(prepared.pendingSigners).toEqual([payer.publicKey()]);
    const signed = await new EscrowClient({ contractId: CONTRACT_ID }).signLifecycleCall(
      JSON.parse(JSON.stringify(prepared)),
      payer,
    );
    expect(signed.pendingSigners).toEqual([]);
    await new EscrowClient({ contractId: CONTRACT_ID }).submitLifecycleCall(
      JSON.parse(JSON.stringify(signed)),
      relayer,
      "top_up",
    );
    expect((await setup.getEscrow(escrowId)).amount).toBe(1_250_000n);
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

    // Simulate the release the releaser is about to send -- the estimate must be
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
      networkPassphrase: "Test DFN Network ; September 2015",
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
  });
});

describe("Prepare / sign / submit against live testnet (issue #58)", () => {
  // The "wallet" is a keypair this test never hands to the SDK: the client only
  // ever sees the payer's public key and a signed XDR string, exactly as with a
  // browser wallet.
  function walletSign(unsignedXdr: string, wallet: Keypair): string {
    const tx = TransactionBuilder.fromXDR(unsignedXdr, "Test SDF Network ; September 2015");
    tx.sign(wallet);
    return tx.toXDR();
  }

  it("prepares for a public key, signs with a separate wallet, and submits", async () => {
    const [wallet, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    const prepared = await client.prepareCreateEscrow({
      payer: wallet.publicKey(),
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-prepared-create",
      releaser: releaser.publicKey(),
    });
    expect(prepared.authSigners).toEqual([]);
    expect(prepared.validUntilLedger).toBeGreaterThan(0);

    const { escrowId, txHash } = await client.submitSigned(walletSign(prepared.xdr, wallet), {
      expectedHash: prepared.hash,
    });

    expect(txHash).toBeTruthy();
    expect(escrowId).toBeDefined();
    expect(await client.getStatus(escrowId!)).toBe("Funded");
  });

  it("lets a sponsor fee-bump a wallet-signed create", async () => {
    const [wallet, payee, releaser, sponsor] = await Promise.all([
      fundedKeypair(), fundedKeypair(), fundedKeypair(), fundedKeypair(),
    ]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const prepared = await client.prepareCreateEscrow({
      payer: wallet.publicKey(),
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-prepared-sponsored",
      releaser: releaser.publicKey(),
    });

    const { escrowId, txHash, innerTxHash } = await client.submitSigned(walletSign(prepared.xdr, wallet), {
      expectedHash: prepared.hash,
      feeBumpSigner: sponsor,
      maxFee: 50_000_000n,
    });

    expect(txHash).not.toBe(innerTxHash);
    expect(await client.getStatus(escrowId!)).toBe("Funded");
  });

  it("rejects a different transaction than the one that was prepared", async () => {
    const [wallet, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const params = {
      payer: wallet.publicKey(),
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      releaser: releaser.publicKey(),
    };
    const prepared = await client.prepareCreateEscrow({ ...params, conditionRef: "sdk-integration-prepared-a" });
    const other = await client.prepareCreateEscrow({ ...params, conditionRef: "sdk-integration-prepared-b" });

    await expect(
      client.submitSigned(walletSign(other.xdr, wallet), { expectedHash: prepared.hash }),
    ).rejects.toBeInstanceOf(SignedTransactionMismatchError);
  });

  it("reports an expired prepared transaction with a typed error", async () => {
    const [wallet, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const prepared = await client.prepareCreateEscrow({
      payer: wallet.publicKey(),
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-prepared-expiry",
      releaser: releaser.publicKey(),
      validForLedgers: 1,
    });
    const signedXdr = walletSign(prepared.xdr, wallet);

    // Wait out the one-ledger window (about five seconds a ledger).
    await new Promise((resolve) => setTimeout(resolve, 20_000));

    await expect(client.submitSigned(signedXdr)).rejects.toBeInstanceOf(PreparedTransactionExpiredError);
  }, 60_000);
});

describeFactory("FactoryClient against live testnet", () => {
  it("predicts the instance address that the factory actually deploys", async () => {
    const integrator = await fundedKeypair();
    const factory = new FactoryClient({ factoryId: FACTORY_ID });
    const salt = Buffer.alloc(32, 0x01);

    // Offline prediction must match the on-chain derivation exactly.
    const predicted = predictInstanceAddress(FACTORY_ID, salt);
    const { instanceId } = await factory.deployInstance({
      integrator: integrator.publicKey(),
      salt,
      signer: integrator,
    });
    expect(instanceId).toBe(predicted);

    // Discovery via the factory must return the same instance.
    const found = await factory.getInstance(integrator.publicKey());
    expect(found?.contractId).toBe(predicted);

    // Deploying again is graceful: the existing address is returned.
    const again = await factory.deployInstance({
      integrator: integrator.publicKey(),
      salt,
      signer: integrator,
    });
    expect(again.instanceId).toBe(predicted);
  });

  it("runs a full lifecycle on a factory-deployed instance", async () => {
    const [integrator, payer, payee, releaser] = await Promise.all([
      fundedKeypair(), fundedKeypair(), fundedKeypair(), fundedKeypair(),
    ]);
    const factory = new FactoryClient({ factoryId: FACTORY_ID });
    const salt = Buffer.alloc(32, 0x02);
    const { instanceId } = await factory.deployInstance({
      integrator: integrator.publicKey(),
      salt,
      signer: integrator,
    });
    expect(instanceId).toBe(predictInstanceAddress(FACTORY_ID, salt));

    const client = await EscrowClient.forIntegrator(factory, integrator.publicKey());
    expect(client.contractId).toBe(instanceId);

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
});
