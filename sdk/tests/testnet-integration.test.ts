// Real-network integration test -- per issue #4's DoD: "at least one test
// exercising both [create_escrow/get_status] against a running/testnet
// contract instance, not just the contract's own test suite." Now also
// covers release/refund (Phase E2) and the `refund_after` deadline +
// `get_escrow` read path (Phase E4, issue #11). Phase E6 adds the
// network-preset + mainnet-guard assertions at the bottom.
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
import { EscrowClient, networks, MAINNET_NETWORK_PASSPHRASE_VALUE } from "../src/index.js";

// Live testnet deployment of the Phase E4 contract (adds `refund_after`
// timeout refund + `get_escrow`) -- see docs/testnet-deployments.md.
// Public contract addresses, not secrets.
const CONTRACT_ID = "CAHP4J3T23WSIBBG6SIVEAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEV5";
const NATIVE_XLM_SAC = "CDLZFC3SYJYDZT7K67ZV75HPJVIEUVNIXF47ZG2FB2RMQUVU2HHGCYSC";

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
    const client = new EscrowClient({ contractId: CONTRACT_ID, network: networks.testnet });

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
    const client = new EscrowClient({ contractId: CONTRACT_ID, network: networks.testnet });

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
    const client = new EscrowClient({ contractId: CONTRACT_ID, network: networks.testnet });

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
    const client = new EscrowClient({ contractId: CONTRACT_ID, network: networks.testnet });

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
    const client = new EscrowClient({ contractId: CONTRACT_ID, network: networks.testnet });

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

  // Phase E6: the client must verify the RPC's reported passphrase
  // against the configured one on the first network call, and cache the
  // result so it is not repeated on every call.
  it("rejects a configured testnet client pointed at a mismatched RPC", async () => {
    const client = new EscrowClient({
      contractId: CONTRACT_ID,
      network: {
        ...networks.testnet,
        // A valid testnet RPC but with a passphrase that does not
        // match what the RPC will report.
        networkPassphrase: "Not a real network passphrase",
      },
    });

    await expect(client.getStatus(0)).rejects.toThrow(
      /RPC network passphrase mismatch/,
    );
  });

  it("caches the passphrase verification across calls", async () => {
    const client = new EscrowClient({ contractId: CONTRACT_ID, network: networks.testnet });

    // First call verifies and caches.
    await expect(client.getStatus(0)).rejects.toThrow();
    // Second call must not re-hit the verification path.
    await expect(client.getStatus(0)).rejects.toThrow();
  });
});

describe("mainnet opt-in guard", () => {
  it("blocks the mainnet passphrase without allowMainnet", () => {
    expect(
      () =>
        new EscrowClient({
          contractId: CONTRACT_ID,
          networkPassphrase: MAINNET_NETWORK_PASSPHRASE_VALUE,
        }),
    ).toThrow(/mainnet network passphrase/i);
  });

  it("blocks a custom network that smuggles in the mainnet passphrase", () => {
    expect(
      () =>
        new EscrowClient({
          contractId: CONTRACT_ID,
          rpcUrl: "https://soroban.stellar.org",
          networkPassphrase: MAINNET_NETWORK_PASSTHRASE_VALUE,
        }),
    ).toThrow(/mainnet network passphrase/i);
  });

  it("allows the mainnet passphrase with an explicit opt-in", () => {
    expect(
      () =>
        new EscrowClient({
          contractId: CONTRACT_ID,
          networkPassphrase: MAINNET_NETWORK_PASSPHRASE_VALUE,
          allowMainnet: true,
        }),
    ).toNotThrow();
  });

  it("allows a custom private-quickstart network with a non-mainnet passphrase", () => {
    expect(
      () =>
        new EscrowClient({
          contractId: CONTRACT_ID,
          rpcUrl: "http://localhost:8000/soroban/rpc",
          networkPassphrase: "Standalone Network ; May 2025",
        }),
    ).toNotThrow();
  });
});
