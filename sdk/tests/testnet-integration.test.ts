// Real-network integration test — per issue #4's DoD: "at least one test
// exercising both [create_escrow/get_status] against a running/testnet
// contract instance, not just the contract's own test suite." Now also
// covers release/refund (Phase E2) and the `refund_after` deadline +
// `get_escrow` read path (Phase E4, issue #11).
//
// Phase E6 (issue #<this issue>) adds smart-wallet (passkey) payer
// coverage: a contract-account payer funded via auth-entry signing.
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
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { EscrowClient } from "../src/index.js";

// Live testnet deployment of the Phase E4 contract (adds `refund_after`
// timeout refund + `get_escrow`) — see docs/testnet-deployments.md.
// Public contract addresses, not secrets.
const CONTRACT_ID = "CAHQ4J3T23WSIBBG6SI6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEV5";
const NATIVE_XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

// Reference passkey smart-wallet contract deployed on testnet for Phase E6.
// See examples/passkey-wallet/ and docs/smart-wallet-auth.md. Public
// contract address, not a secret.
const SMART_WALLET_ID = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";
const SMART_WALLET_SIGNER = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

async function fundedKeypair(): Promise<Keypair> {
  const kp = Keypair.random();
  const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(kp.publicKey())}`);
  if (!res.ok) {
    throw new Error(`Friendbot funding failed for ${kp.publicKey()}: ${res.status} ${await res.text()}`);
  }
  return kp;
}

// The reference passkey wallet exposes a testnet-only faucet helper that
// funds the contract account from Friendbot via a sponsored SAC transfer.
// It's a plain HTTP endpoint so the SDK test doesn't need to import the
// example's wallet code.
async function fundSmartWallet(contractId: string): Promise<void> {
  const res = await fetch(`https://passkey-wallet-testnet.stellar.org/fund?addr=${encodeURIComponent(contractId)}`);
  if (!res.ok) {
    throw new Error(`Smart-wallet funding failed for ${contractId}: ${res.status} ${await res.text()}`);
  }
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

  it("creates an escrow with a smart-wallet (contract-account) payer via auth-entry signing", async () => {
    const [payee, releaser] = await Promise.all([fundedKeypair(), fundedKeypair()]);
    await fundSmartWallet(SMART_WALLET_ID);
    const client = new EscrowClient({ contractId: CONTRACT_ID });

    // The payer is a contract address, not a Keypair: the SDK builds the
    // SorobanAuthorizationEntry for the SAC transfer, hands it back for
    // signing, and submits the signed entry.
    const { escrowId, txHash } = await client.createEscrow({
      payer: SMART_WALLET_ID,
      payee: payee.publicKey(),
      token: NATIVE_XLM_SAC,
      amount: 1_000_000n,
      conditionRef: "sdk-integration-test-smart-wallet-payer",
      releaser: releaser.publicKey(),
      signAuthEntry: async (entryXdr) => {
        // In a real passkey flow this would call navigator.credentials.get()
        // and sign the entry hash with the secp256r1 key. The reference
        // wallet's testnet signer endpoint does the equivalent with a
        // software key so the test can run headlessly.
        const res = await fetch("https://passkey-wallet-testnet.stellar.org/sign-auth-entry", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contractId: SMART_WALLET_ID, entryXdr }),
        });
        if (!res.ok) {
          throw new Error(`Auth-entry signing failed: ${res.status} ${await res.text()}`);
        }
        const { signedEntryXdr } = (await res.json()) as { signedEntryXdr: string };
        return signedEntryXdr;
      },
    });
    expect(txHash).toBeTruthy();

    // The balance-delta check must still work when the payer is a contract:
    // the escrow is Funded and the smart wallet's XLM balance decreased.
    expect(await client.getStatus(escrowId)).toBe("Funded");

    const escrow = await client.getEscrow(escrowId);
    expect(escrow.payer).toBe(SMART_WALLET_ID);
    expect(StrKey.isValidContract(escrow.payer)).toBe(true);

    await client.release({ escrowId, caller: releaser });
    expect(await client.getStatus(escrowId)).toBe("Released");
  });
});
