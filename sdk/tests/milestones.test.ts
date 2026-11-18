// Offline tests for the milestone schedule surface (issue #71). No RPC, no
// network: a milestone escrow is a client-side group of single-tranche
// escrows, so these cover the schedule arithmetic, the per-tranche
// `condition_ref` tagging, and the orchestration over `createEscrow` /
// `release` / `getEscrow` — including the partial-failure state, which is the
// one way a group can go wrong.
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  EscrowClient,
  MAX_CONDITION_REF_LENGTH,
  MilestoneEscrowPartialError,
  MilestoneScheduleError,
  milestoneConditionRef,
  validateMilestoneSchedule,
  type CreateMilestoneEscrowParams,
  type MilestoneEscrow,
} from "../src/index.js";

const CONTRACT_ID = "CAHQ4J3T23WSIBBG6SI6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEV5";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const I128_MAX = 2n ** 127n - 1n;

function client(): EscrowClient {
  return new EscrowClient({ contractId: CONTRACT_ID });
}

function milestoneParams(overrides: Partial<CreateMilestoneEscrowParams> = {}): CreateMilestoneEscrowParams {
  return {
    payer: Keypair.random(),
    payee: Keypair.random().publicKey(),
    token: TOKEN,
    amount: 1_000_000n,
    conditionRef: "sdk-unit-milestones",
    releaser: Keypair.random().publicKey(),
    milestones: [600_000n, 400_000n],
    ...overrides,
  };
}

describe("validateMilestoneSchedule", () => {
  it("accepts a schedule whose tranches sum exactly to the amount", () => {
    expect(() => validateMilestoneSchedule([600_000n, 400_000n], 1_000_000n)).not.toThrow();
  });

  it("accepts a single tranche covering the whole amount", () => {
    expect(() => validateMilestoneSchedule([1_000_000n], 1_000_000n)).not.toThrow();
  });

  it("rejects an empty schedule", () => {
    expect(() => validateMilestoneSchedule([], 1_000_000n)).toThrow(MilestoneScheduleError);
    expect(() => validateMilestoneSchedule([], 1_000_000n)).toThrow(/schedule must not be empty/);
  });

  it("rejects a non-positive tranche, naming its index", () => {
    expect(() => validateMilestoneSchedule([1_000_000n, 0n], 1_000_000n)).toThrow(/tranche 1 must be positive/);
    expect(() => validateMilestoneSchedule([-1n, 1_000_001n], 1_000_000n)).toThrow(/tranche 0 must be positive/);
  });

  it("rejects a schedule that does not sum to the amount", () => {
    expect(() => validateMilestoneSchedule([600_000n, 399_999n], 1_000_000n)).toThrow(
      /schedule sums to 999999 but amount is 1000000/,
    );
  });

  it("rejects a non-positive amount", () => {
    expect(() => validateMilestoneSchedule([0n], 0n)).toThrow(/amount must be positive/);
  });

  it("rejects values the contract's i128 arithmetic could not hold", () => {
    expect(() => validateMilestoneSchedule([I128_MAX + 1n], I128_MAX + 1n)).toThrow(/exceeds the i128 maximum/);
    // Each tranche fits on its own, but the running sum overflows.
    expect(() => validateMilestoneSchedule([I128_MAX, I128_MAX], I128_MAX)).toThrow(
      /schedule total exceeds the i128 maximum/,
    );
  });
});

describe("milestoneConditionRef", () => {
  it("tags each tranche with its position and the schedule size", () => {
    expect(milestoneConditionRef("invoice-42", 0, 3)).toBe("invoice-42#m1/3");
    expect(milestoneConditionRef("invoice-42", 2, 3)).toBe("invoice-42#m3/3");
  });

  it("keeps the tagged ref inside the contract's byte limit", () => {
    const longest = "x".repeat(MAX_CONDITION_REF_LENGTH - "#m10/10".length);
    expect(milestoneConditionRef(longest, 9, 10)).toHaveLength(MAX_CONDITION_REF_LENGTH);
    expect(() => milestoneConditionRef(longest, 9, 10)).not.toThrow();
  });

  it("rejects a base ref with no room left for the tag", () => {
    expect(() => milestoneConditionRef("x".repeat(MAX_CONDITION_REF_LENGTH), 0, 2)).toThrow(
      MilestoneScheduleError,
    );
    expect(() => milestoneConditionRef("x".repeat(MAX_CONDITION_REF_LENGTH), 0, 2)).toThrow(
      /is too long/,
    );
  });
});

describe("createMilestoneEscrow", () => {
  it("creates one escrow per tranche, in order, with tagged refs", async () => {
    const calls: Array<{ amount: bigint; conditionRef: string }> = [];
    const createEscrow = vi.fn(async (params: { amount: bigint; conditionRef: string }) => {
      calls.push({ amount: params.amount, conditionRef: params.conditionRef });
      return { escrowId: 100n + BigInt(calls.length), txHash: `hash-${calls.length}` };
    });
    const escrowClient = Object.assign(client(), { createEscrow });

    const group = await escrowClient.createMilestoneEscrow(
      milestoneParams({ milestones: [600_000n, 300_000n, 100_000n] }),
    );

    expect(createEscrow).toHaveBeenCalledTimes(3);
    expect(calls).toEqual([
      { amount: 600_000n, conditionRef: "sdk-unit-milestones#m1/3" },
      { amount: 300_000n, conditionRef: "sdk-unit-milestones#m2/3" },
      { amount: 100_000n, conditionRef: "sdk-unit-milestones#m3/3" },
    ]);
    expect(group.escrowIds).toEqual([101n, 102n, 103n]);
    expect(group.milestones).toEqual([
      { index: 0, amount: 600_000n, escrowId: 101n, status: "unreleased" },
      { index: 1, amount: 300_000n, escrowId: 102n, status: "unreleased" },
      { index: 2, amount: 100_000n, escrowId: 103n, status: "unreleased" },
    ]);
  });

  it("rejects a schedule that does not sum to the amount before building anything", async () => {
    const createEscrow = vi.fn();
    const escrowClient = Object.assign(client(), { createEscrow });

    await expect(
      escrowClient.createMilestoneEscrow(milestoneParams({ milestones: [600_000n, 300_000n] })),
    ).rejects.toThrow(MilestoneScheduleError);
    expect(createEscrow).not.toHaveBeenCalled();
  });

  it("rejects an over-long conditionRef before building anything", async () => {
    const createEscrow = vi.fn();
    const escrowClient = Object.assign(client(), { createEscrow });

    await expect(
      escrowClient.createMilestoneEscrow(
        milestoneParams({ conditionRef: "x".repeat(MAX_CONDITION_REF_LENGTH), milestones: [1_000_000n] }),
      ),
    ).rejects.toThrow(/is too long/);
    expect(createEscrow).not.toHaveBeenCalled();
  });

  it("reports the tranches already funded when creation fails partway", async () => {
    let call = 0;
    const createEscrow = vi.fn(async () => {
      call += 1;
      if (call === 2) throw new Error("simulated RPC failure");
      return { escrowId: 100n + BigInt(call), txHash: `hash-${call}` };
    });
    const escrowClient = Object.assign(client(), { createEscrow });

    const failure = await escrowClient
      .createMilestoneEscrow(milestoneParams({ milestones: [500_000n, 300_000n, 200_000n] }))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MilestoneEscrowPartialError);
    const partial = failure as MilestoneEscrowPartialError;
    // The first tranche is funded on-chain; the caller has to release or
    // refund it rather than assume nothing happened.
    expect(partial.createdEscrowIds).toEqual([101n]);
    expect(partial.createdCount).toBe(1);
    expect(partial.totalCount).toBe(3);
    expect(partial.message).toContain("tranche 2 of 3");
    expect((partial.cause as Error).message).toBe("simulated RPC failure");
  });
});

describe("per-tranche settlement", () => {
  const group: MilestoneEscrow = {
    escrowIds: [11n, 12n],
    milestones: [
      { index: 0, amount: 600_000n, escrowId: 11n, status: "unreleased" },
      { index: 1, amount: 400_000n, escrowId: 12n, status: "unreleased" },
    ],
  };

  it("releases only the selected tranche's escrow", async () => {
    const release = vi.fn(async () => ({ txHash: "released-12" }));
    const escrowClient = Object.assign(client(), { release });
    const caller = Keypair.random();

    await expect(escrowClient.releaseMilestone({ escrow: group, milestoneIndex: 1, caller })).resolves.toEqual({
      txHash: "released-12",
    });
    expect(release).toHaveBeenCalledWith({ escrowId: 12n, caller });
  });

  it("refunds only the selected tranche's escrow", async () => {
    const refund = vi.fn(async () => ({ txHash: "refunded-11" }));
    const escrowClient = Object.assign(client(), { refund });
    const caller = Keypair.random();

    await escrowClient.refundMilestone({ escrow: group, milestoneIndex: 0, caller });
    expect(refund).toHaveBeenCalledWith({ escrowId: 11n, caller });
  });

  it("rejects an index outside the schedule", async () => {
    const escrowClient = Object.assign(client(), { release: vi.fn() });
    const caller = Keypair.random();

    await expect(escrowClient.releaseMilestone({ escrow: group, milestoneIndex: 2, caller })).rejects.toThrow(
      RangeError,
    );
    await expect(escrowClient.releaseMilestone({ escrow: group, milestoneIndex: -1, caller })).rejects.toThrow(
      /outside the schedule/,
    );
  });

  it("maps each tranche escrow's status onto the milestone view", async () => {
    const statuses: Record<string, string> = { "11": "Released", "12": "Funded" };
    const escrowClient = Object.assign(client(), {
      getEscrow: vi.fn(async (escrowId: bigint) => ({ status: statuses[escrowId.toString()] })),
    });

    await expect(escrowClient.getMilestones(group)).resolves.toEqual([
      { index: 0, amount: 600_000n, escrowId: 11n, status: "released" },
      { index: 1, amount: 400_000n, escrowId: 12n, status: "unreleased" },
    ]);
  });

  it("reports refunded and cancelled tranches as refunded", async () => {
    const statuses: Record<string, string> = { "11": "Refunded", "12": "Cancelled" };
    const escrowClient = Object.assign(client(), {
      getEscrow: vi.fn(async (escrowId: bigint) => ({ status: statuses[escrowId.toString()] })),
    });

    const milestones = await escrowClient.getMilestones(group);
    expect(milestones.map((milestone) => milestone.status)).toEqual(["refunded", "refunded"]);
  });
});
