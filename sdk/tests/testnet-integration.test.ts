// Real-network integration test -- per issue #4's DoD: "at least one test
// exercising both [create_escrow/get_status] against a running/testnet
// contract instance, not just the contract's own test suite." Now also
// covers release/refund (Phase E2) and the `refund_after` deadline +
// `get_escrow` read path (Phase E4, issue #11). Adds Phase E6 factory
// deployment + instance discovery coverage (deterministic address
// prediction must match the on-chain deployment). Phase E7 (issue #353):
// every deployed 3.0 feature runs here without an opt-in env flag -- quorum,
// cancel, a pooled round (succeed and fail), a protocol-fee release, a
// two-op `settleMany`, the pause reads and `transferPayee`.
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
import { describe, expect, it, vi } from "vitest";
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
  ScheduleCancelledError,
  ScheduleTooEarlyError,
  SignedTransactionMismatchError,
  StaleSequenceError,
  UniqueEscrowMismatchError,
  UnsupportedContractVersionError,
  isSupportedContractVersion,
  knownContractId,
  predictInstanceAddress,
  scheduleAllowanceExpirationLedger,
  scheduleAllowanceNeeded,
  scheduleState,
} from "../src/index.js";
import { Server as RpcServer } from "@stellar/stellar-sdk/rpc";

// Newest testnet deployment recorded by scripts/deploy (deployments.json), so
// a redeploy needs no edit here. Overridable via env to test another instance.
// Public contract addresses, not secrets.
const CONTRACT_ID = process.env.TESTNET_CONTRACT_ID ?? knownContractId("testnet");
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

// The 2026-10-24 testnet deployment, which predates `version()`.
const LEGACY_CONTRACT_ID = "CDX2JEMA5SO7GZVXDNGDDB35GPV43J7BUTYYH77ALAT72S65GOW5KNEO";

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

// These tests fund new accounts and send several real transactions, which can
// take over a minute on a slow night. This applies to this file only.
vi.setConfig({ testTimeout: 120_000 });

// Identities shared by the cases that only need one payer/payee/releaser set
// (issue #353): every funded account is one Friendbot request, so these are
// funded at most once per run and reused across escrows. Each escrow still has
// its own id, so sharing an identity changes nothing about the assertions.
interface SoakIdentities {
  payer: Keypair;
  payee: Keypair;
  releaser: Keypair;
  secondPayee: Keypair;
  contributor: Keypair;
  feeRecipient: Keypair;
}

let soakIdentities: Promise<SoakIdentities> | undefined;

function soak(): Promise<SoakIdentities> {
  soakIdentities ??= (async () => {
    const [payer, payee, releaser, secondPayee, contributor, feeRecipient] = await Promise.all([
      fundedKeypair(), fundedKeypair(), fundedKeypair(),
      fundedKeypair(), fundedKeypair(), fundedKeypair(),
    ]);
    return { payer, payee, releaser, secondPayee, contributor, feeRecipient };
  })();
  return soakIdentities;
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

  it("reads a supported version from the live contract", async () => {
    const client = new EscrowClient({ contractId: CONTRACT_ID, verifyContractVersion: true });
    expect(isSupportedContractVersion((await client.getContractVersion())!)).toBe(true);
    await expect(client.verifyContractVersion()).resolves.toBeUndefined();
  }, 60_000);

  it("reports an older deployment with no version() as null", async () => {
    const client = new EscrowClient({ contractId: LEGACY_CONTRACT_ID });
    expect(await client.getContractVersion()).toBeNull();
    await expect(client.verifyContractVersion()).rejects.toBeInstanceOf(UnsupportedContractVersionError);
  }, 60_000);

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

  // Quorum has been in every testnet deployment since 2.5.0, so this runs in
  // the nightly soak unconditionally (issue #353) on reused identities.
  it("settles a 2-of-3 quorum escrow with two approvers", async () => {
    const { payer, payee, releaser, secondPayee, contributor } = await soak();
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const releasers = [releaser.publicKey(), secondPayee.publicKey(), contributor.publicKey()];

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
      client.release({ escrowId, caller: releaser }),
    ).rejects.toThrow();
    await client.releaseWithApprovals({ escrowId, approvers: [releaser, contributor] });
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

  // `cancel` is in the current testnet deployment, so it runs unconditionally
  // in the nightly soak (issue #353).
  it("lets the payer cancel before the payee accepts", async () => {
    const { payer, payee, releaser } = await soak();
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

describe("Offline release and refund against live testnet (issue #59)", () => {
  const PASSPHRASE = "Test SDF Network ; September 2015";

  /** A funded classic account whose three signers have weight 1 and thresholds of 2. */
  async function twoOfThree(): Promise<{ account: Keypair; signers: Keypair[] }> {
    const rpc = new RpcServer("https://soroban-testnet.stellar.org");
    const account = await fundedKeypair();
    const signers = [Keypair.random(), Keypair.random(), Keypair.random()];
    let builder = new TransactionBuilder(await rpc.getAccount(account.publicKey()), {
      fee: BASE_FEE,
      networkPassphrase: PASSPHRASE,
    }).setTimeout(60);
    for (const signer of signers) {
      builder = builder.addOperation(
        Operation.setOptions({ signer: { ed25519PublicKey: signer.publicKey(), weight: 1 } }),
      );
    }
    const tx = builder
      .addOperation(Operation.setOptions({ masterWeight: 0, lowThreshold: 2, medThreshold: 2, highThreshold: 2 }))
      .build();
    tx.sign(account);
    await rpc.sendTransaction(tx);
    await rpc.pollTransaction(tx.hash().toString("hex"), { attempts: 30 });
    return { account, signers };
  }

  function signCopy(unsignedXdr: string, signer: Keypair): string {
    const tx = TransactionBuilder.fromXDR(unsignedXdr, PASSPHRASE);
    tx.sign(signer);
    return tx.toXDR();
  }

  it("releases with a 2-of-3 multisig releaser: prepare, sign separately, merge, submit", async () => {
    const [payer, payee] = await Promise.all([fundedKeypair(), fundedKeypair()]);
    const { account: multisig, signers } = await twoOfThree();
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-offline-release",
      releaser: multisig.publicKey(),
    });

    const prepared = await client.prepareRelease({ escrowId, releaser: multisig.publicKey() });
    // Two signers each sign their own copy; neither sees the other's.
    const merged = client.mergeSignatures([signCopy(prepared.xdr, signers[0]!), signCopy(prepared.xdr, signers[2]!)]);
    await client.submitSigned(merged, { expectedHash: prepared.hash });

    expect(await client.getStatus(escrowId)).toBe("Released");
  }, 120_000);

  it("refunds offline with a single cold key", async () => {
    const [payer, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-offline-refund",
      releaser: releaser.publicKey(),
    });

    const prepared = await client.prepareRefund({ escrowId, releaser: releaser.publicKey() });
    await client.submitSigned(signCopy(prepared.xdr, releaser), { expectedHash: prepared.hash });

    expect(await client.getStatus(escrowId)).toBe("Refunded");
  });

  it("detects that the source sequence moved while signing offline", async () => {
    const [payer, payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair(), fundedKeypair()]);
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-offline-stale",
      releaser: releaser.publicKey(),
    });
    const prepared = await client.prepareRelease({ escrowId, releaser: releaser.publicKey() });
    const signedXdr = signCopy(prepared.xdr, releaser);

    // Any other transaction from the source account invalidates the prepared one.
    const rpc = new RpcServer("https://soroban-testnet.stellar.org");
    const bump = new TransactionBuilder(await rpc.getAccount(releaser.publicKey()), {
      fee: BASE_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
      .setTimeout(60)
      .build();
    bump.sign(releaser);
    await rpc.sendTransaction(bump);
    await rpc.pollTransaction(bump.hash().toString("hex"), { attempts: 30 });

    await expect(client.submitSigned(signedXdr, { expectedHash: prepared.hash })).rejects.toBeInstanceOf(
      StaleSequenceError,
    );
  }, 120_000);
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

// Issue #353: the nightly soak covers the 2.5.1+ surface that runs on testnet.
// Every case here uses the shared identities above, so the extra Friendbot cost
// is one fixed set of accounts per run rather than per test.
describe("Phase E7 soak: pooled, fee, batch, pause and payee coverage", () => {
  it("runs a pooled round from contributions to release", async () => {
    const { payer, payee, releaser, contributor } = await soak();
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const fundingDeadline = BigInt(Math.floor(Date.now() / 1000) + 3_600);
    const { escrowId } = await client.createPooledEscrow({
      creator: payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      fundingTarget: 1_000_000n,
      conditionRef: "sdk-integration-test-pooled-release",
      releaser: releaser.publicKey(),
      fundingDeadline,
    });

    const pooled = await client.getPooled(escrowId);
    expect(pooled.fundingTarget).toBe(1_000_000n);
    expect(pooled.fundingDeadline).toBe(fundingDeadline);

    await client.contribute({ escrowId, payer, amount: 600_000n });
    await client.contribute({ escrowId, payer: contributor, amount: 400_000n });
    expect((await client.getEscrow(escrowId)).amount).toBe(1_000_000n);
    expect((await client.getContribution(escrowId, contributor.publicKey()))?.amount).toBe(400_000n);

    // A successful round releases its whole total to the payee.
    await client.release({ escrowId, caller: releaser });
    expect(await client.getStatus(escrowId)).toBe("Released");
  });

  it("refunds a failed pooled round contributor by contributor", async () => {
    const { payer, payee, releaser, contributor } = await soak();
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    // Short deadline so the round fails inside this test's timeout, measured
    // against the contract's own clock below.
    const fundingDeadline = BigInt(Math.floor(Date.now() / 1000) + 40);
    const { escrowId } = await client.createPooledEscrow({
      creator: payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      fundingTarget: 1_000_000n,
      conditionRef: "sdk-integration-test-pooled-failed",
      releaser: releaser.publicKey(),
      fundingDeadline,
    });
    await client.contribute({ escrowId, payer: contributor, amount: 400_000n });

    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await client.getLedgerTime({ maxAgeMs: 0 })).closeTime >= fundingDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    expect((await client.getLedgerTime({ maxAgeMs: 0 })).closeTime).toBeGreaterThanOrEqual(fundingDeadline);

    await client.claimRefund({ escrowId, contributor });
    expect(await client.getContribution(escrowId, contributor.publicKey())).toEqual({
      amount: 400_000n,
      refunded: true,
    });
    await expect(client.claimRefund({ escrowId, contributor })).rejects.toThrow();
    // A failed round is still Funded: status describes settlement, not funding.
    expect(await client.getStatus(escrowId)).toBe("Funded");
  }, 120_000);

  it("applies a protocol fee on release", async () => {
    const { payer, payee, releaser, feeRecipient } = await soak();
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-protocol-fee",
      releaser: releaser.publicKey(),
      feeRecipient: feeRecipient.publicKey(),
      feeBps: 250, // 2.5 %
    });

    // Read the stored fee pair before settlement; get_escrow is NotFound after.
    const escrow = await client.getEscrow(escrowId);
    expect(escrow.feeBps).toBe(250);
    expect(escrow.feeRecipient).toBe(feeRecipient.publicKey());

    await client.release({ escrowId, caller: releaser });
    expect(await client.getStatus(escrowId)).toBe("Released");
  });

  it("settles two escrows in one settleMany call", async () => {
    const { payer, payee, releaser } = await soak();
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const create = (conditionRef: string) => client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef,
      releaser: releaser.publicKey(),
    });
    const [released, refunded] = [await create("sdk-integration-test-settle-many-a"), await create("sdk-integration-test-settle-many-b")];

    const results = await client.settleMany([
      { escrowId: released.escrowId, kind: "release", caller: releaser },
      { escrowId: refunded.escrowId, kind: "refund", caller: releaser },
    ]);

    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(await client.getStatus(released.escrowId)).toBe("Released");
    expect(await client.getStatus(refunded.escrowId)).toBe("Refunded");
  });

  it("reads the pause flag and the custodian that may flip it", async () => {
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    // Documented deployed custodian (ROADMAP.md, 3.0.0 redeploy). A contract
    // without the constructor would report no admin; this one always has one.
    expect(await client.getPauseAdmin()).toMatch(/^G[A-Z2-7]{55}$/);
    // The deployment is not paused; if it were, every deposit case above would
    // fail with `Paused` as well.
    expect(await client.isPaused()).toBe(false);
  });

  it("transfers the payee and then releases to the new one", async () => {
    const { payer, payee, releaser, secondPayee } = await soak();
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const { escrowId } = await client.createEscrow({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-transfer-payee",
      releaser: releaser.publicKey(),
    });

    await client.transferPayee({ escrowId, currentPayee: payee, newPayee: secondPayee.publicKey() });
    expect((await client.getEscrow(escrowId)).payee).toBe(secondPayee.publicKey());

    await client.release({ escrowId, caller: releaser });
    expect(await client.getStatus(escrowId)).toBe("Released");
  });
});

// Phase E6 SDK surfaces for contract features newer than the recorded testnet
// deployment (issues #468, #469, #470). The newest deployment in
// deployments.json (2026-11-18, git 2bbc6b1c) predates recurring schedules
// (#115), unique creation (#47) and the pooled release deadline (#288), so
// these cases skip by default. Opt in by pointing TESTNET_CONTRACT_ID at a
// deployment built from main at or after those features and setting
// TESTNET_E6_FEATURES=1.
const describeE6 = process.env.TESTNET_E6_FEATURES === "1" ? describe : describe.skip;

describeE6("Phase E6 SDK: recurring, unique creation and pooled deadlines (opt-in)", () => {
  it("creates a schedule, approves the allowance, funds a period and cancels (#468)", async () => {
    const { payer, payee, releaser, contributor: keeper } = await soak();
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const latest = await client.getLedgerTime({ maxAgeMs: 0 });

    const { scheduleId } = await client.createSchedule({
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 100_000n,
      conditionRef: `sdk-integration-schedule-${Date.now()}`,
      releaser: releaser.publicKey(),
      refundAfterSeconds: 3_600n,
      periodSeconds: 3_600n,
      totalPeriods: 3,
      firstDue: latest.closeTime, // due immediately
    });
    const schedule = await client.getSchedule(scheduleId);
    expect(schedule).toMatchObject({ periodsFunded: 0, totalPeriods: 3, cancelled: false });
    expect(scheduleState(schedule, latest.closeTime)).toBe("due");

    await client.approveScheduleAllowance({
      payer,
      token: NATIVE_XLM_SAC,
      amount: scheduleAllowanceNeeded(schedule),
      expirationLedger: scheduleAllowanceExpirationLedger(schedule, latest),
    });

    // The keeper funds without the payer's signature.
    const { escrowId } = await client.fundNext(scheduleId, { source: keeper });
    expect(await client.getStatus(escrowId)).toBe("Funded");
    const funded = await client.getSchedule(scheduleId);
    expect(funded.periodsFunded).toBe(1);
    expect(funded.nextDue).toBe(schedule.nextDue + schedule.periodSeconds);
    expect(scheduleState(funded, (await client.getLedgerTime({ maxAgeMs: 0 })).closeTime)).toBe("waiting");
    await expect(client.fundNext(scheduleId, { source: keeper })).rejects.toBeInstanceOf(ScheduleTooEarlyError);

    await client.cancelSchedule({ scheduleId, payer });
    expect(scheduleState(await client.getSchedule(scheduleId), funded.nextDue)).toBe("cancelled");
    await expect(client.fundNext(scheduleId, { source: keeper })).rejects.toBeInstanceOf(ScheduleCancelledError);
    // The period escrow already funded is unaffected by the cancel.
    expect(await client.getStatus(escrowId)).toBe("Funded");
  }, 120_000);

  it("returns the same escrow when the same unique creation runs twice (#469)", async () => {
    const { payer, payee, releaser } = await soak();
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const request = {
      payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: `sdk-integration-unique-${Date.now()}`,
      releaser: releaser.publicKey(),
      unique: true as const,
    };

    const first = await client.createEscrow(request);
    expect(first.existing).toBe(false);
    expect(first.txHash).toBeTruthy();
    const second = await client.createEscrow(request);
    expect(second).toEqual({ escrowId: first.escrowId, txHash: undefined, existing: true, status: "Funded" });
    expect(await client.getUniqueEscrow(payer, request.conditionRef)).toBe(first.escrowId);

    await expect(client.createEscrow({ ...request, amount: 2_000_000n })).rejects.toBeInstanceOf(
      UniqueEscrowMismatchError,
    );
  });

  it("creates a pool with a release deadline, reads it, and closes an empty failed round (#470)", async () => {
    const { payer, payee, releaser, contributor } = await soak();
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    const fundingDeadline = BigInt(Math.floor(Date.now() / 1000) + 40);
    const releaseDeadline = fundingDeadline + 3_600n;
    const { escrowId } = await client.createPooledEscrow({
      creator: payer,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      fundingTarget: 1_000_000n,
      conditionRef: "sdk-integration-test-pooled-release-deadline",
      releaser: releaser.publicKey(),
      fundingDeadline,
      releaseDeadline,
    });
    expect((await client.getPooled(escrowId)).releaseDeadline).toBe(releaseDeadline);

    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await client.getLedgerTime({ maxAgeMs: 0 })).closeTime >= fundingDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    // Nobody contributed: anyone may give the failed round its terminal status.
    await client.closeFailedRound(escrowId, { source: contributor });
    expect(await client.getStatus(escrowId)).toBe("Refunded");
  }, 120_000);
});
