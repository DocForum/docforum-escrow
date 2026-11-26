// Offline tests for retry-safe creation (issue #469; contract issue #47):
// createEscrow({ unique: true }) → create_escrow_with_uniqueness, recovery of
// a DuplicateConditionRef via get_unique_escrow, the terms check, the settled
// case, rejected option combinations, and that the non-unique path is
// byte-for-byte unchanged.
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import {
  DuplicateConditionRefError,
  NotFoundError,
  NotFundedError,
  UniqueEscrowMismatchError,
  type CreatedEscrow,
  type CreateEscrowParams,
  type Escrow,
  type EscrowClient,
  type UniqueCreateEscrowResult,
  type UniqueCreateEscrowParams,
} from "../src/index.js";
import {
  encodeArgs,
  expectMatchesSpec,
  failingSendTx,
  makeClient,
  rejectionOf,
  sendableTx,
} from "./contract-spec-args.js";

const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const payer = Keypair.random();
const payee = Keypair.random().publicKey();
const releaser = Keypair.random().publicKey();

function params(overrides: Partial<CreateEscrowParams> = {}): CreateEscrowParams {
  return {
    payer,
    payee,
    token: TOKEN,
    amount: 5_000n,
    conditionRef: "order-42",
    releaser,
    refundAfter: 1_900_000_000n,
    ...overrides,
  };
}

function uniqueParams(overrides: Partial<UniqueCreateEscrowParams> | Record<string, unknown> = {}): UniqueCreateEscrowParams {
  return { ...params(), ...overrides, unique: true } as UniqueCreateEscrowParams;
}

function storedEscrow(overrides: Partial<Escrow> = {}): Escrow {
  return {
    payer: payer.publicKey(),
    payee,
    token: TOKEN,
    amount: 5_000n,
    conditionRef: "order-42",
    releasers: [releaser],
    threshold: 1,
    refundAfter: 1_900_000_000n,
    notifyPayee: false,
    refundTo: payer.publicKey(),
    requiresAcceptance: false,
    status: "Funded",
    ...overrides,
  };
}

const DUPLICATE_AT_SIMULATION = () => {
  throw new Error("HostError: Error(Contract, #60)\n\nEvent log (newest first): ...");
};

/** Contract-client fakes plus spies for the reads the recovery path makes. */
function harness(contract: Record<string, unknown>, reads: Record<string, unknown> = {}) {
  const create_escrow = vi.fn(async (_args: Record<string, unknown>) => sendableTx(1n, "plain-hash"));
  const create_escrow_with_uniqueness = vi.fn(async (_args: Record<string, unknown>) => sendableTx(9n, "unique-hash"));
  const getUniqueEscrow = vi.fn(async () => 3n as bigint | undefined);
  const getEscrow = vi.fn(async () => storedEscrow());
  const getStatus = vi.fn(async () => "Released");
  const fakes = {
    create_escrow,
    create_escrow_with_uniqueness,
    create_escrow_release_time: vi.fn(),
    create_escrow_with_acceptance: vi.fn(),
    ...contract,
  };
  const client = makeClient({ contractClient: () => fakes, getUniqueEscrow, getEscrow, getStatus, ...reads });
  return { client, fakes, getUniqueEscrow, getEscrow, getStatus };
}

describe("createEscrow without unique", () => {
  it("keeps the plain return type for callers typed with CreateEscrowParams (no breaking change)", () => {
    const plain = (client: EscrowClient, p: CreateEscrowParams) => client.createEscrow(p);
    const unique = (client: EscrowClient, p: UniqueCreateEscrowParams) => client.createEscrow(p);
    expectTypeOf(plain).returns.resolves.toEqualTypeOf<CreatedEscrow>();
    expectTypeOf(unique).returns.resolves.toEqualTypeOf<UniqueCreateEscrowResult>();
  });

  it("sends exactly the same create_escrow call for unique: false and for no unique at all", async () => {
    const omitted = harness({});
    const explicitFalse = harness({});

    const a = await omitted.client.createEscrow(params());
    const b = await explicitFalse.client.createEscrow(params({ unique: false }));

    expect(a).toEqual({ escrowId: 1n, txHash: "plain-hash" });
    expect(b).toEqual({ escrowId: 1n, txHash: "plain-hash" });
    expect("existing" in a).toBe(false);
    const argsA = omitted.fakes.create_escrow.mock.calls[0][0];
    const argsB = explicitFalse.fakes.create_escrow.mock.calls[0][0];
    expect(argsB).toEqual(argsA);
    const encodedA = expectMatchesSpec("create_escrow", argsA);
    const encodedB = expectMatchesSpec("create_escrow", argsB);
    expect(encodedB.map((v) => v.toXDR("base64"))).toEqual(encodedA.map((v) => v.toXDR("base64")));
    expect(omitted.fakes.create_escrow_with_uniqueness).not.toHaveBeenCalled();
    expect(explicitFalse.fakes.create_escrow_with_uniqueness).not.toHaveBeenCalled();
  });
});

describe("createEscrow({ unique: true })", () => {
  it("sends create_escrow's exact arguments plus unique_ref: true", async () => {
    const plain = harness({});
    const unique = harness({});

    await plain.client.createEscrow(params({ feeRecipient: Keypair.random().publicKey(), feeBps: 50, notifyPayee: true }));
    const feeRecipient = plain.fakes.create_escrow.mock.calls[0][0].fee_recipient as string;
    const result = await unique.client.createEscrow(uniqueParams({ feeRecipient, feeBps: 50, notifyPayee: true }));

    expect(result).toEqual({ escrowId: 9n, txHash: "unique-hash", existing: false });
    const plainArgs = plain.fakes.create_escrow.mock.calls[0][0];
    const uniqueArgs = unique.fakes.create_escrow_with_uniqueness.mock.calls[0][0];
    expect(uniqueArgs).toEqual({ ...plainArgs, unique_ref: true });
    const encoded = expectMatchesSpec("create_escrow_with_uniqueness", uniqueArgs);
    const plainEncoded = encodeArgs("create_escrow", plainArgs);
    expect(encoded.slice(0, -1).map((v) => v.toXDR("base64"))).toEqual(plainEncoded.map((v) => v.toXDR("base64")));
    expect(encoded.at(-1)!.toXDR("base64")).toBe(xdr.ScVal.scvBool(true).toXDR("base64"));
    expect(unique.fakes.create_escrow).not.toHaveBeenCalled();
    expect(unique.getUniqueEscrow).not.toHaveBeenCalled();
  });

  it("resolves a duplicate at simulation to the existing escrow after checking its terms", async () => {
    const h = harness({ create_escrow_with_uniqueness: vi.fn(DUPLICATE_AT_SIMULATION) });

    const result = await h.client.createEscrow(uniqueParams());

    expect(result).toEqual({ escrowId: 3n, txHash: undefined, existing: true, status: "Funded" });
    expect(h.getUniqueEscrow).toHaveBeenCalledWith(payer.publicKey(), "order-42");
    expect(h.getEscrow).toHaveBeenCalledWith(3n);
    expect(h.getStatus).not.toHaveBeenCalled();
  });

  it("resolves a duplicate at submission (e.g. a resubmitted transaction) the same way", async () => {
    const tx = failingSendTx(new Error("transaction failed: Error(Contract, #60)"));
    const h = harness({ create_escrow_with_uniqueness: vi.fn(async () => tx) });

    const result = await h.client.createEscrow(uniqueParams());

    expect(result).toMatchObject({ escrowId: 3n, existing: true, txHash: undefined });
    expect(tx.send).toHaveBeenCalledTimes(1);
  });

  it("resolves a duplicate surfaced by the result's Err (no numeric code in the message)", async () => {
    const tx = sendableTx(0n, "landed");
    tx.send.mockResolvedValueOnce({
      result: {
        unwrap: () => {
          throw new Error("DuplicateConditionRef");
        },
      },
      sendTransactionResponse: { hash: "landed" },
    } as never);
    const h = harness({ create_escrow_with_uniqueness: vi.fn(async () => tx) });

    expect(await h.client.createEscrow(uniqueParams())).toMatchObject({ escrowId: 3n, existing: true });
  });

  it("throws UniqueEscrowMismatchError, never success, when the stored terms differ", async () => {
    const otherPayee = Keypair.random().publicKey();
    const h = harness(
      { create_escrow_with_uniqueness: vi.fn(DUPLICATE_AT_SIMULATION) },
      { getEscrow: vi.fn(async () => storedEscrow({ payee: otherPayee, amount: 4_000n })) },
    );

    const error = await rejectionOf(h.client.createEscrow(uniqueParams()));

    expect(error).toBeInstanceOf(UniqueEscrowMismatchError);
    const mismatch = error as UniqueEscrowMismatchError;
    expect(mismatch.escrowId).toBe(3n);
    expect(mismatch.mismatched).toEqual(["payee", "amount"]);
    expect(mismatch.expected).toEqual({ payee, token: TOKEN, amount: 5_000n });
    expect(mismatch.actual).toEqual({ payee: otherPayee, token: TOKEN, amount: 4_000n });
    expect(mismatch.cause).toBeDefined();
  });

  it("detects a token mismatch", async () => {
    const h = harness(
      { create_escrow_with_uniqueness: vi.fn(DUPLICATE_AT_SIMULATION) },
      { getEscrow: vi.fn(async () => storedEscrow({ token: Keypair.random().publicKey() })) },
    );
    const error = await rejectionOf(h.client.createEscrow(uniqueParams()));
    expect((error as UniqueEscrowMismatchError).mismatched).toEqual(["token"]);
  });

  it.each([
    ["NotFunded", () => new NotFundedError()],
    ["NotFound", () => new NotFoundError()],
  ])("returns a settled duplicate (getEscrow → %s) with its status and skips the terms check", async (_name, error) => {
    // A settled escrow's record is reclaimed (ADR 0013); the index survives.
    const h = harness(
      { create_escrow_with_uniqueness: vi.fn(DUPLICATE_AT_SIMULATION) },
      { getEscrow: vi.fn(async () => { throw error(); }) },
    );

    // Different terms would mismatch, but a settled record can't be read: no check.
    const result = await h.client.createEscrow(uniqueParams({ amount: 1n }));

    expect(result).toEqual({ escrowId: 3n, txHash: undefined, existing: true, status: "Released" });
    expect(h.getStatus).toHaveBeenCalledWith(3n);
  });

  it("rethrows DuplicateConditionRef if the index read finds no id", async () => {
    const h = harness(
      { create_escrow_with_uniqueness: vi.fn(DUPLICATE_AT_SIMULATION) },
      { getUniqueEscrow: vi.fn(async () => undefined) },
    );
    expect(await rejectionOf(h.client.createEscrow(uniqueParams()))).toBeInstanceOf(DuplicateConditionRefError);
  });

  it("does not treat other contract errors as duplicates", async () => {
    const h = harness({
      create_escrow_with_uniqueness: vi.fn(() => {
        throw new Error("HostError: Error(Contract, #8)");
      }),
    });
    await expect(h.client.createEscrow(uniqueParams())).rejects.toThrow(/#8/);
    expect(h.getUniqueEscrow).not.toHaveBeenCalled();
  });

  it.each([
    [{ requiresAcceptance: true }, /requiresAcceptance/],
    [{ releaseNotBefore: 1_800_000_000n }, /releaseNotBefore/],
    [{ releasers: [releaser], threshold: 1 }, /releasers, threshold/],
  ])("rejects unique with %o before anything is sent", async (overrides, message) => {
    const h = harness({});
    const error = await rejectionOf(h.client.createEscrow(uniqueParams(overrides)));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toMatch(message);
    for (const fake of Object.values(h.fakes)) expect(fake).not.toHaveBeenCalled();
  });

  it("still runs createEscrow's offline checks", async () => {
    const h = harness({});
    await expect(h.client.createEscrow(uniqueParams({ amount: 0n }))).rejects.toThrow(/InvalidAmount/);
    expect(h.fakes.create_escrow_with_uniqueness).not.toHaveBeenCalled();
  });
});

describe("getUniqueEscrow", () => {
  it("reads get_unique_escrow and maps None to undefined", async () => {
    const get_unique_escrow = vi
      .fn(async (_args: Record<string, unknown>) => ({ result: 12n as bigint | undefined }))
      .mockResolvedValueOnce({ result: 12n })
      .mockResolvedValueOnce({ result: undefined });
    const client = makeClient({ contractClient: () => ({ get_unique_escrow }) });

    expect(await client.getUniqueEscrow(payer.publicKey(), "order-42")).toBe(12n);
    expect(await client.getUniqueEscrow(payer, "order-42")).toBeUndefined();
    expect(get_unique_escrow).toHaveBeenNthCalledWith(1, { payer: payer.publicKey(), condition_ref: "order-42" });
    expect(get_unique_escrow).toHaveBeenNthCalledWith(2, { payer: payer.publicKey(), condition_ref: "order-42" });
    expectMatchesSpec("get_unique_escrow", get_unique_escrow.mock.calls[0][0]);
  });

  it("scopes the lookup to the payer", async () => {
    const other = Keypair.random().publicKey();
    const index = new Map([[`${payer.publicKey()}|order-42`, 12n]]);
    const get_unique_escrow = vi.fn(async ({ payer: p, condition_ref }: { payer: string; condition_ref: string }) => ({
      result: index.get(`${p}|${condition_ref}`),
    }));
    const client = makeClient({ contractClient: () => ({ get_unique_escrow }) });

    expect(await client.getUniqueEscrow(payer, "order-42")).toBe(12n);
    expect(await client.getUniqueEscrow(other, "order-42")).toBeUndefined();
  });
});
