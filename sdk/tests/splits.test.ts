/**
 * Offline unit tests for split payouts and the protocol fee (issue #72,
 * docs/adr/0011). These cover the client-side validation and the offline
 * mirror of the contract's payout maths; the on-chain behaviour is covered by
 * `contracts/escrow/tests/splits.rs`.
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  BPS_DENOMINATOR,
  EscrowClient,
  MAX_SPLIT_RECIPIENTS,
  computePayout,
  validateFee,
  validateSplits,
  type SplitRecipient,
} from "../src/index.js";

function recipients(...shares: number[]): SplitRecipient[] {
  return shares.map((bps) => ({ address: Keypair.random().publicKey(), bps }));
}

function newClient(): EscrowClient {
  return new EscrowClient({
    contractId: Keypair.random().publicKey(),
    rpcUrl: "https://127.0.0.1:1",
  });
}

function createParams(extra: Record<string, unknown> = {}) {
  return {
    payer: Keypair.random(),
    payee: Keypair.random().publicKey(),
    token: Keypair.random().publicKey(),
    amount: 1_000_000n,
    conditionRef: "splits-unit",
    releaser: Keypair.random().publicKey(),
    ...extra,
  };
}

describe("validateSplits", () => {
  it("accepts shares that sum to the full denominator", () => {
    const splits = recipients(6_000, 4_000);
    expect(() => validateSplits(splits)).not.toThrow();
  });

  it("accepts a single recipient taking everything", () => {
    expect(() => validateSplits(recipients(BPS_DENOMINATOR))).not.toThrow();
  });

  it("rejects an empty list", () => {
    expect(() => validateSplits([])).toThrow(/at least one recipient/);
  });

  it("rejects more than the contract maximum", () => {
    const tooMany = recipients(...Array(MAX_SPLIT_RECIPIENTS + 1).fill(1));
    expect(() => validateSplits(tooMany)).toThrow(/at most 10/);
  });

  it("rejects shares that do not sum to 10,000", () => {
    expect(() => validateSplits(recipients(5_000, 4_999))).toThrow(/must sum to 10000/);
  });

  it("rejects a zero share", () => {
    expect(() => validateSplits(recipients(0, 10_000))).toThrow(/integer in 1/);
  });

  it("rejects non-integer basis points", () => {
    expect(() => validateSplits(recipients(5_000.5, 4_999.5))).toThrow(/integer/);
  });

  it("rejects duplicate recipients", () => {
    const address = Keypair.random().publicKey();
    expect(() =>
      validateSplits([
        { address, bps: 5_000 },
        { address, bps: 5_000 },
      ]),
    ).toThrow(/repeat/);
  });

  it("rejects the escrow contract as a recipient", () => {
    const contractId = Keypair.random().publicKey();
    expect(() => validateSplits([{ address: contractId, bps: 10_000 }], contractId)).toThrow(
      /cannot be the escrow contract/,
    );
  });
});

describe("validateFee", () => {
  it("allows no fee", () => {
    expect(() => validateFee(undefined)).not.toThrow();
  });

  it("allows 0 bps", () => {
    expect(() => validateFee({ bps: 0, recipient: Keypair.random().publicKey() })).not.toThrow();
  });

  it("rejects a fee above the denominator", () => {
    expect(() => validateFee({ bps: 10_001, recipient: Keypair.random().publicKey() })).toThrow(
      /0..=10000/,
    );
  });

  it("rejects a negative or fractional fee", () => {
    expect(() => validateFee({ bps: -1, recipient: Keypair.random().publicKey() })).toThrow();
    expect(() => validateFee({ bps: 1.5, recipient: Keypair.random().publicKey() })).toThrow();
  });

  it("rejects the escrow contract as fee recipient", () => {
    const contractId = Keypair.random().publicKey();
    expect(() => validateFee({ bps: 100, recipient: contractId }, contractId)).toThrow(
      /cannot be the escrow contract/,
    );
  });
});

describe("computePayout", () => {
  it("gives everything to the payee when there are no splits", () => {
    const payee = Keypair.random().publicKey();
    const preview = computePayout(1_000_000n, [], undefined, payee);
    expect(preview.feeAmount).toBe(0n);
    expect(preview.payouts).toEqual([{ address: payee, amount: 1_000_000n }]);
    expect(preview.total).toBe(1_000_000n);
  });

  it("takes the fee off the top with floor division", () => {
    const splits = recipients(10_000);
    const fee = { bps: 250, recipient: Keypair.random().publicKey() };
    const preview = computePayout(1_000_001n, splits, fee);
    // 1_000_001 * 250 / 10_000 = 25_000.025 -> 25_000
    expect(preview.feeAmount).toBe(25_000n);
    expect(preview.payouts[0].amount).toBe(975_001n);
    expect(preview.total).toBe(1_000_001n);
  });

  it("puts the rounding remainder on the last recipient", () => {
    const splits = recipients(3_333, 3_333, 3_334);
    const preview = computePayout(100n, splits);
    const amounts = preview.payouts.map((p) => p.amount);
    // 100 * 3_333 / 10_000 = 33 (floor) for the first two; the last takes
    // whatever is left so nothing is stranded.
    expect(amounts).toEqual([33n, 33n, 34n]);
    expect(amounts.reduce((a, b) => a + b, 0n)).toBe(100n);
  });

  it("always distributes exactly amount minus fee", () => {
    const splits = recipients(1_111, 2_222, 6_667);
    const fee = { bps: 137, recipient: Keypair.random().publicKey() };
    const preview = computePayout(9_999_999n, splits, fee);
    const paid = preview.payouts.reduce((sum, share) => sum + share.amount, 0n);
    expect(paid + preview.feeAmount).toBe(9_999_999n);
  });

  it("rejects a non-positive amount", () => {
    expect(() => computePayout(0n, [], undefined, Keypair.random().publicKey())).toThrow(
      /must be positive/,
    );
  });

  it("requires a payee when there are no splits", () => {
    expect(() => computePayout(10n, [])).toThrow(/payee is required/);
  });

  it("reports the last recipient as fee recipient when no fee is set", () => {
    const splits = recipients(5_000, 5_000);
    const preview = computePayout(1_000n, splits);
    expect(preview.feeAmount).toBe(0n);
    expect(preview.feeRecipient).toBe(preview.payouts[preview.payouts.length - 1].address);
  });
});

describe("EscrowClient.createEscrow routing", () => {
  it("calls create_escrow_with_splits when splits are supplied", async () => {
    const client = newClient();
    const createWithSplits = vi.fn().mockResolvedValue({
      result: { unwrap: () => 7n },
      sendTransactionResponse: { hash: "abc" },
    });
    const plain = vi.fn();
    (client as unknown as { contractClient: () => unknown }).contractClient = () => ({
      create_escrow_with_splits: createWithSplits,
      create_escrow: plain,
    });
    (client as unknown as { invoke: unknown }).invoke = async (
      _method: string,
      _id: unknown,
      build: () => Promise<unknown>,
    ) => build();

    const splits = recipients(6_000, 4_000);
    const result = await client.createEscrow(createParams({ splits }) as never);
    expect(result.escrowId).toBe(7n);
    expect(plain).not.toHaveBeenCalled();
    expect(createWithSplits).toHaveBeenCalledTimes(1);
    const args = createWithSplits.mock.calls[0][0];
    expect(args.splits).toEqual(splits);
    expect(args.fee_bps).toBe(0);
  });

  it("keeps using create_escrow when neither splits nor fee are supplied", async () => {
    const client = newClient();
    const plain = vi.fn().mockResolvedValue({
      result: { unwrap: () => 9n },
      sendTransactionResponse: { hash: "def" },
    });
    (client as unknown as { contractClient: () => unknown }).contractClient = () => ({
      create_escrow: plain,
      create_escrow_with_splits: vi.fn(),
    });
    (client as unknown as { invoke: unknown }).invoke = async (
      _method: string,
      _id: unknown,
      build: () => Promise<unknown>,
    ) => build();

    const result = await client.createEscrow(createParams() as never);
    expect(result.escrowId).toBe(9n);
    expect(plain).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid splits before touching the network", async () => {
    const client = newClient();
    const contractClient = vi.fn();
    (client as unknown as { contractClient: () => unknown }).contractClient = contractClient;

    await expect(
      client.createEscrow(createParams({ splits: recipients(5_000, 4_000) }) as never),
    ).rejects.toThrow(/must sum to 10000/);
    expect(contractClient).not.toHaveBeenCalled();
  });

  it("rejects a fee without splits", async () => {
    const client = newClient();
    (client as unknown as { contractClient: () => unknown }).contractClient = vi.fn();
    await expect(
      client.createEscrow(
        createParams({ fee: { bps: 100, recipient: Keypair.random().publicKey() } }) as never,
      ),
    ).rejects.toThrow(/fee without splits/);
  });
});
