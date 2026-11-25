/**
 * Offline unit tests for the SDK's pooled escrow surface (issue #113,
 * docs/adr/0011). The validation cases must reject *before* any RPC call;
 * the release-deadline and closeFailedRound cases (issue #470) replace the
 * contract client with fakes. The suite makes no network requests and is
 * safe for CI.
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { ContractError, EscrowClient, MAX_CONDITION_REF_LENGTH, utf8ByteLength } from "../src/index.js";
import { encodeArgs, expectMatchesSpec, makeClient, readResult, sendableTx } from "./contract-spec-args.js";

const client = new EscrowClient({
  // Never contacted: validation fails before the client is built.
  contractId: Keypair.random().publicKey(),
  rpcUrl: "https://127.0.0.1:1",
});

const creator = Keypair.random();

function pooledCreateParams(overrides: Record<string, unknown>) {
  return {
    creator,
    payee: Keypair.random().publicKey(),
    token: Keypair.random().publicKey(),
    fundingTarget: 1_000_000n,
    conditionRef: "pooled-validation",
    releaser: Keypair.random().publicKey(),
    fundingDeadline: 1_760_000_000n,
    ...overrides,
  } as never;
}

describe("createPooledEscrow validation", () => {
  it("rejects an oversized conditionRef", async () => {
    await expect(
      client.createPooledEscrow(pooledCreateParams({ conditionRef: "a".repeat(MAX_CONDITION_REF_LENGTH + 1) }))
    ).rejects.toThrow(/conditionRef/);
  });

  it("rejects a conditionRef over the byte limit even when its char count fits", async () => {
    // 33 two-byte characters = 66 bytes (> 64) but only 33 UTF-16 units.
    await expect(
      client.createPooledEscrow(pooledCreateParams({ conditionRef: "é".repeat(33) }))
    ).rejects.toThrow(/conditionRef/);
  });

  it("rejects a non-positive funding target", async () => {
    for (const fundingTarget of [0n, -1n]) {
      await expect(
        client.createPooledEscrow(pooledCreateParams({ fundingTarget }))
      ).rejects.toThrow(/fundingTarget/);
    }
  });

  it("rejects a non-positive funding deadline", async () => {
    await expect(
      client.createPooledEscrow(pooledCreateParams({ fundingDeadline: 0n }))
    ).rejects.toThrow(/fundingDeadline/);
  });

  it("passes validation for a well-formed request, then needs the network", async () => {
    // Valid input only fails on the (unreachable) RPC connection — i.e. no
    // validation error fired.
    await expect(client.createPooledEscrow(pooledCreateParams({}))).rejects.not.toThrow(
      /conditionRef must|fundingTarget must|fundingDeadline must/
    );
  });
});

describe("utf8ByteLength boundary", () => {
  it("counts astral (emoji) characters as 4 bytes", () => {
    expect(utf8ByteLength("😀")).toBe(4);
    expect(utf8ByteLength("😀".repeat(16))).toBe(64);
  });

  it("accepts exactly 64 bytes and rejects 65 for multi-byte input", async () => {
    // 32 two-byte characters = 64 bytes: the length check must pass.
    // The call then fails on the unreachable network, not on conditionRef.
    await expect(
      client.createPooledEscrow(pooledCreateParams({ conditionRef: "é".repeat(32) }))
    ).rejects.not.toThrow(/conditionRef/);
    // 16 emoji = 64 bytes: must pass the length check.
    await expect(
      client.createPooledEscrow(pooledCreateParams({ conditionRef: "😀".repeat(16) }))
    ).rejects.not.toThrow(/conditionRef/);
    // 16 emoji + 1 ASCII = 65 bytes: must fail.
    await expect(
      client.createPooledEscrow(pooledCreateParams({ conditionRef: "😀".repeat(16) + "a" }))
    ).rejects.toThrow(/conditionRef/);
  });
});

describe("contribute validation", () => {
  it("rejects zero and negative contribution amounts", async () => {
    for (const amount of [0n, -5n]) {
      await expect(
        client.contribute({ escrowId: 7n, payer: creator, amount })
      ).rejects.toThrow(/amount must be/);
    }
  });
});

// ---------------------------------------------------------------------------
// Release deadline (issue #288) and closeFailedRound (issue #289), SDK issue
// #470. Encoding is checked against contract-spec.json with no network.
// ---------------------------------------------------------------------------

describe("createPooledEscrow releaseDeadline", () => {
  const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  function pooledClient() {
    const create_pooled_escrow = vi.fn(async (_args: Record<string, unknown>) => sendableTx(4n, "pooled-hash"));
    const create_pooled_release_deadline = vi.fn(async (_args: Record<string, unknown>) =>
      sendableTx(5n, "deadline-hash"),
    );
    const invoked: string[] = [];
    const client = makeClient({ contractClient: () => ({ create_pooled_escrow, create_pooled_release_deadline }) });
    const invoke = client["invoke"].bind(client);
    (client as unknown as { invoke: typeof invoke }).invoke = ((method: string, ...rest: unknown[]) => {
      invoked.push(method);
      return (invoke as (...args: unknown[]) => unknown)(method, ...rest);
    }) as typeof invoke;
    return { client, create_pooled_escrow, create_pooled_release_deadline, invoked };
  }

  const base = () => pooledCreateParams({ token: TOKEN, fundingDeadline: 1_900_000_000n });

  it("keeps calling create_pooled_escrow with today's arguments when releaseDeadline is omitted", async () => {
    const { client, create_pooled_escrow, create_pooled_release_deadline, invoked } = pooledClient();

    const result = await client.createPooledEscrow(base());

    expect(result).toEqual({ escrowId: 4n, txHash: "pooled-hash" });
    expect(invoked).toEqual(["create_pooled_escrow"]);
    expect(create_pooled_release_deadline).not.toHaveBeenCalled();
    const args = create_pooled_escrow.mock.calls[0][0];
    expectMatchesSpec("create_pooled_escrow", args);
    expect(Object.keys(args)).not.toContain("release_deadline");
  });

  it("calls create_pooled_release_deadline with the deadline when it is set", async () => {
    const { client, create_pooled_escrow, create_pooled_release_deadline, invoked } = pooledClient();
    const params = { ...(base() as object), releaseDeadline: 1_900_086_400n } as never;

    const result = await client.createPooledEscrow(params);

    expect(result).toEqual({ escrowId: 5n, txHash: "deadline-hash" });
    expect(invoked).toEqual(["create_pooled_release_deadline"]);
    expect(create_pooled_escrow).not.toHaveBeenCalled();
    const args = create_pooled_release_deadline.mock.calls[0][0];
    const encoded = expectMatchesSpec("create_pooled_release_deadline", args);
    expect(args.release_deadline).toBe(1_900_086_400n);
    expect(encoded.at(-1)!.switch().name).toBe("scvU64");
    // Every other argument is exactly what create_pooled_escrow would get.
    const { release_deadline: _deadline, ...rest } = args;
    expect(encodeArgs("create_pooled_escrow", rest).map((v) => v.toXDR("base64"))).toEqual(
      encoded.slice(0, -1).map((v) => v.toXDR("base64")),
    );
  });

  it.each([1_900_000_000n, 1_899_999_999n, 0n])(
    "rejects releaseDeadline %s (not after fundingDeadline) with InvalidReleaseDeadline",
    async (releaseDeadline) => {
      const { client, create_pooled_escrow, create_pooled_release_deadline } = pooledClient();
      await expect(
        client.createPooledEscrow({ ...(base() as object), releaseDeadline } as never),
      ).rejects.toThrow(/InvalidReleaseDeadline/);
      expect(create_pooled_escrow).not.toHaveBeenCalled();
      expect(create_pooled_release_deadline).not.toHaveBeenCalled();
    },
  );
});

describe("getPooled releaseDeadline", () => {
  function pooledRead(tx: unknown) {
    const get_pooled = vi.fn(async (_args: Record<string, unknown>) => tx);
    return { client: makeClient({ contractClient: () => ({ get_pooled }) }), get_pooled };
  }

  it("decodes a release deadline", async () => {
    const { client, get_pooled } = pooledRead(
      readResult({ funding_target: 1_000n, funding_deadline: 1_900_000_000n, release_deadline: 1_900_086_400n }),
    );
    expect(await client.getPooled(3n)).toEqual({
      fundingTarget: 1_000n,
      fundingDeadline: 1_900_000_000n,
      releaseDeadline: 1_900_086_400n,
    });
    expectMatchesSpec("get_pooled", get_pooled.mock.calls[0][0]);
  });

  it("maps a None release deadline to undefined", async () => {
    const { client } = pooledRead(
      readResult({ funding_target: 1_000n, funding_deadline: 1_900_000_000n, release_deadline: null }),
    );
    const pooled = await client.getPooled(3n);
    expect(pooled.releaseDeadline).toBeUndefined();
    expect(pooled.fundingTarget).toBe(1_000n);
  });

  it("decodes a deployment that predates the field by name", async () => {
    const legacy = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("funding_deadline"), val: nativeToScVal(1_900_000_000n, { type: "u64" }) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("funding_target"), val: nativeToScVal(1_000n, { type: "i128" }) }),
    ]);
    const { client } = pooledRead({
      result: {
        unwrap: () => {
          throw new TypeError("Cannot read properties of undefined");
        },
      },
      simulationData: { result: { retval: legacy } },
    });
    expect(await client.getPooled(3n)).toEqual({
      fundingTarget: 1_000n,
      fundingDeadline: 1_900_000_000n,
      releaseDeadline: undefined,
    });
  });
});

describe("closeFailedRound", () => {
  it("calls close_failed_round with the escrow id, signed by any source", async () => {
    const tx = sendableTx(undefined, "close-hash");
    const close_failed_round = vi.fn(async (_args: Record<string, unknown>) => tx);
    const contractClient = vi.fn((_signer?: unknown) => ({ close_failed_round }));
    const client = makeClient({ contractClient });
    const anyone = Keypair.random();

    const result = await client.closeFailedRound(8n, { source: anyone });

    expect(result).toEqual({ txHash: "close-hash" });
    expect(contractClient).toHaveBeenCalledWith(anyone);
    expect(close_failed_round).toHaveBeenCalledWith({ escrow_id: 8n });
    expectMatchesSpec("close_failed_round", close_failed_round.mock.calls[0][0]);
    expect(tx.unwrap).toHaveBeenCalledTimes(1);
  });

  it.each([
    [30, "RefundNotOpen"],
    [28, "FundingTargetReached"],
    [26, "NotPooled"],
  ])("surfaces contract error %i (%s) with its code", async (code) => {
    const client = makeClient({
      contractClient: () => ({
        close_failed_round: async () => {
          throw new Error(`HostError: Error(Contract, #${code})`);
        },
      }),
    });
    const error = await client.closeFailedRound(8n, { source: Keypair.random() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).code).toBe(code);
  });
});