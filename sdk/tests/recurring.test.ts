// Offline tests for the recurring-schedule SDK surface (issue #468; contract
// issue #115, ADR 0015): createSchedule / getSchedule / fundNext /
// cancelSchedule / approveScheduleAllowance, the pure scheduleState and
// allowance helpers, and the typed errors. Every rule is checked against
// contracts/escrow/src/recurring.rs and the creation path it calls.
import { describe, expect, it, vi } from "vitest";
import { Keypair, scValToNative } from "@stellar/stellar-sdk";
import { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import {
  AllowanceExhaustedError,
  ContractError,
  InvalidScheduleError,
  MAX_CONDITION_REF_LENGTH,
  NotFoundError,
  PausedError,
  ScheduleCancelledError,
  ScheduleCompleteError,
  ScheduleParamsError,
  ScheduleTooEarlyError,
  UnauthorizedError,
  remainingPeriods,
  scheduleAllowanceExpirationLedger,
  scheduleAllowanceNeeded,
  scheduleState,
  type CreateScheduleParams,
  type RecurringSchedule,
} from "../src/index.js";
import {
  expectMatchesSpec,
  failingSendTx,
  makeClient,
  readResult,
  rejectionOf,
  sendableTx,
} from "./contract-spec-args.js";

const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const CONTRACT_ID = "CAANBNO7UXU24RVORQSGV33VJ7ZPL4UQKQNGPOSCSDDLISQ35SH62Y6E";
const payer = Keypair.random();
const payee = Keypair.random().publicKey();
const releaser = Keypair.random().publicKey();
const keeper = Keypair.random();

function scheduleParams(overrides: Partial<CreateScheduleParams> = {}): CreateScheduleParams {
  return {
    payer,
    payee,
    token: TOKEN,
    amount: 250n,
    conditionRef: "sub-42",
    releaser,
    refundAfterSeconds: 86_400n,
    periodSeconds: 2_592_000n,
    totalPeriods: 12,
    firstDue: 1_900_000_000n,
    ...overrides,
  };
}

function schedule(overrides: Partial<RecurringSchedule> = {}): RecurringSchedule {
  return {
    payer: payer.publicKey(),
    payee,
    token: TOKEN,
    amount: 250n,
    conditionRef: "sub-42",
    releaser,
    refundAfterSeconds: 86_400n,
    periodSeconds: 100n,
    totalPeriods: 3,
    periodsFunded: 0,
    nextDue: 1_000n,
    cancelled: false,
    ...overrides,
  };
}

/** A client whose contract client exposes `create_schedule`; returns the spy. */
function creatingClient(scheduleId = 7n, contractId = CONTRACT_ID) {
  const create_schedule = vi.fn(async (_args: Record<string, unknown>) => sendableTx(scheduleId, "create-hash"));
  const client = makeClient({ contractClient: () => ({ create_schedule }) }, contractId);
  return { client, create_schedule };
}

describe("createSchedule", () => {
  it("calls create_schedule with the spec's arguments and returns the id and hash", async () => {
    const { client, create_schedule } = creatingClient(7n);

    const result = await client.createSchedule(scheduleParams());

    expect(result).toEqual({ scheduleId: 7n, txHash: "create-hash" });
    expect(create_schedule).toHaveBeenCalledTimes(1);
    const args = create_schedule.mock.calls[0][0];
    const encoded = expectMatchesSpec("create_schedule", args);
    expect(args).toEqual({
      payer: payer.publicKey(),
      payee,
      token: TOKEN,
      amount: 250n,
      condition_ref: "sub-42",
      releaser,
      refund_after_seconds: 86_400n,
      period_seconds: 2_592_000n,
      total_periods: 12,
      first_due: 1_900_000_000n,
    });
    expect(scValToNative(encoded[8])).toBe(12); // total_periods is a u32
  });

  it("encodes an omitted refundAfterSeconds as None", async () => {
    const { client, create_schedule } = creatingClient();
    await client.createSchedule(scheduleParams({ refundAfterSeconds: undefined }));
    const encoded = expectMatchesSpec("create_schedule", create_schedule.mock.calls[0][0]);
    expect(encoded[6].switch().name).toBe("scvVoid");
  });

  it("accepts a first due time already in the past (the contract allows it)", async () => {
    const { client, create_schedule } = creatingClient();
    await client.createSchedule(scheduleParams({ firstDue: 0n }));
    expect(create_schedule).toHaveBeenCalledTimes(1);
  });

  // Each rule and the contract error it mirrors. None may reach the network.
  const rejected: Array<[string, Partial<CreateScheduleParams>, string]> = [
    ["zero amount", { amount: 0n }, "InvalidAmount"],
    ["negative amount", { amount: -1n }, "InvalidAmount"],
    ["zero periodSeconds", { periodSeconds: 0n }, "InvalidSchedule"],
    ["zero totalPeriods", { totalPeriods: 0 }, "InvalidSchedule"],
    ["fractional totalPeriods", { totalPeriods: 1.5 }, "InvalidSchedule"],
    ["totalPeriods above u32", { totalPeriods: 2 ** 32 }, "InvalidSchedule"],
    ["negative periodSeconds", { periodSeconds: -1n }, "InvalidSchedule"],
    ["firstDue above u64", { firstDue: 1n << 64n }, "InvalidSchedule"],
    ["65-byte ASCII conditionRef", { conditionRef: "a".repeat(MAX_CONDITION_REF_LENGTH + 1) }, "ConditionRefTooLong"],
    // 22 three-byte characters: 22 UTF-16 units (would pass a .length check) but 66 UTF-8 bytes.
    ["conditionRef over 64 UTF-8 bytes", { conditionRef: "€".repeat(22) }, "ConditionRefTooLong"],
    ["payee is the contract", { payee: CONTRACT_ID }, "InvalidPayeeList"],
    ["zero refundAfterSeconds", { refundAfterSeconds: 0n }, "InvalidRefundAfter"],
    ["refundAfterSeconds above u64", { refundAfterSeconds: 1n << 64n }, "InvalidSchedule"],
    ["releaser is the contract", { releaser: CONTRACT_ID }, "InvalidReleaser"],
    ["next_due overflows u64", { firstDue: (1n << 64n) - 100n, periodSeconds: 50n, totalPeriods: 2 }, "Overflow"],
  ];

  it.each(rejected)("rejects %s before any network call (%s)", async (_label, overrides, contractError) => {
    const { client, create_schedule } = creatingClient();
    const error = await rejectionOf(client.createSchedule(scheduleParams(overrides)));
    expect(error).toBeInstanceOf(ScheduleParamsError);
    expect((error as ScheduleParamsError).contractError).toBe(contractError);
    expect((error as Error).message).toContain(contractError);
    expect(create_schedule).not.toHaveBeenCalled();
  });

  it("accepts exactly 64 UTF-8 bytes of multi-byte conditionRef", async () => {
    const { client, create_schedule } = creatingClient();
    await client.createSchedule(scheduleParams({ conditionRef: "€".repeat(21) + "a" })); // 63 + 1 bytes
    expect(create_schedule).toHaveBeenCalledTimes(1);
  });

  it("accepts the largest firstDue whose last next_due still fits", async () => {
    const { client, create_schedule } = creatingClient();
    await client.createSchedule(scheduleParams({ firstDue: (1n << 64n) - 1n - 100n, periodSeconds: 50n, totalPeriods: 2 }));
    expect(create_schedule).toHaveBeenCalledTimes(1);
  });

  it("rejects a payer that is the contract itself (InvalidRefundTo)", async () => {
    const contractSigner = Keypair.random();
    const { client, create_schedule } = creatingClient(7n, contractSigner.publicKey());
    const error = await rejectionOf(client.createSchedule(scheduleParams({ payer: contractSigner })));
    expect((error as ScheduleParamsError).contractError).toBe("InvalidRefundTo");
    expect(create_schedule).not.toHaveBeenCalled();
  });

  it("checks the token allowlist once the client has read it", async () => {
    const allowed = Keypair.random().publicKey();
    const create_schedule = vi.fn(async () => sendableTx(1n));
    const client = makeClient(
      { contractClient: () => ({ create_schedule, get_allowed_tokens: async () => ({ result: [allowed] }) }) },
      CONTRACT_ID,
    );

    // Unknown allowlist: the contract decides.
    await client.createSchedule(scheduleParams());
    expect(create_schedule).toHaveBeenCalledTimes(1);

    await client.getAllowedTokens();
    const error = await rejectionOf(client.createSchedule(scheduleParams()));
    expect((error as ScheduleParamsError).contractError).toBe("DisallowedToken");
    expect(create_schedule).toHaveBeenCalledTimes(1);

    await client.createSchedule(scheduleParams({ token: allowed }));
    expect(create_schedule).toHaveBeenCalledTimes(2);
  });

  it("treats an empty allowlist as allow-all", async () => {
    const create_schedule = vi.fn(async () => sendableTx(1n));
    const client = makeClient(
      { contractClient: () => ({ create_schedule, get_allowed_tokens: async () => ({ result: [] }) }) },
      CONTRACT_ID,
    );
    await client.getAllowedTokens();
    await client.createSchedule(scheduleParams());
    expect(create_schedule).toHaveBeenCalledTimes(1);
  });

  it.each([
    [38, PausedError],
    [59, InvalidScheduleError],
  ])("surfaces contract error %i from simulation as a typed error", async (code, ErrorClass) => {
    const client = makeClient({
      contractClient: () => ({
        create_schedule: async () => {
          throw new Error(`HostError: Error(Contract, #${code})`);
        },
      }),
    });
    const error = await rejectionOf(client.createSchedule(scheduleParams()));
    expect(error).toBeInstanceOf(ErrorClass);
    expect((error as ContractError).code).toBe(code);
  });
});

describe("getSchedule", () => {
  const generated = {
    payer: payer.publicKey(),
    payee,
    token: TOKEN,
    amount: 170141183460469231731687303715884105727n, // i128 max survives as a bigint
    condition_ref: "sub-42",
    releaser,
    refund_after_seconds: 3_600n,
    period_seconds: 60n,
    total_periods: 4,
    periods_funded: 1,
    next_due: 1_900_000_060n,
    cancelled: false,
  };

  it("decodes RecurringSchedule into the typed shape", async () => {
    const get_schedule = vi.fn(async () => readResult(generated));
    const client = makeClient({ contractClient: () => ({ get_schedule }) });

    const result = await client.getSchedule(5n);

    expect(get_schedule).toHaveBeenCalledWith({ schedule_id: 5n });
    expectMatchesSpec("get_schedule", { schedule_id: 5n });
    expect(result).toEqual({
      payer: payer.publicKey(),
      payee,
      token: TOKEN,
      amount: 170141183460469231731687303715884105727n,
      conditionRef: "sub-42",
      releaser,
      refundAfterSeconds: 3_600n,
      periodSeconds: 60n,
      totalPeriods: 4,
      periodsFunded: 1,
      nextDue: 1_900_000_060n,
      cancelled: false,
    });
    expect(typeof result.amount).toBe("bigint");
  });

  it("maps a None refund window to undefined", async () => {
    const client = makeClient({
      contractClient: () => ({ get_schedule: async () => readResult({ ...generated, refund_after_seconds: null }) }),
    });
    expect((await client.getSchedule(5n)).refundAfterSeconds).toBeUndefined();
  });

  it("throws NotFoundError for an unknown id", async () => {
    const client = makeClient({
      contractClient: () => ({
        get_schedule: async () => {
          throw new Error("HostError: Error(Contract, #1)");
        },
      }),
    });
    expect(await rejectionOf(client.getSchedule(99n))).toBeInstanceOf(NotFoundError);
  });
});

describe("fundNext", () => {
  it("calls fund_next as the keeper, with no payer, and returns the period escrow id", async () => {
    const tx = sendableTx(31n, "fund-hash");
    const fund_next = vi.fn(async (_args: Record<string, unknown>) => tx);
    const contractClient = vi.fn((_signer?: unknown) => ({ fund_next }));
    const client = makeClient({ contractClient });

    const result = await client.fundNext(4n, { source: keeper });

    expect(result).toEqual({ escrowId: 31n, txHash: "fund-hash" });
    expect(contractClient).toHaveBeenCalledWith(keeper);
    expect(fund_next).toHaveBeenCalledWith({ schedule_id: 4n });
    expectMatchesSpec("fund_next", fund_next.mock.calls[0][0]);
  });

  it.each([
    [55, ScheduleTooEarlyError],
    [56, ScheduleCompleteError],
    [57, ScheduleCancelledError],
    [58, AllowanceExhaustedError],
    [38, PausedError],
    [1, NotFoundError],
  ])("maps simulation error %i to its typed error without retrying", async (code, ErrorClass) => {
    const fund_next = vi.fn(async () => {
      throw new Error(`HostError: Error(Contract, #${code})\n\nEvent log (newest first): ...`);
    });
    const client = makeClient({ contractClient: () => ({ fund_next }) });
    const error = await rejectionOf(client.fundNext(4n, { source: keeper }));
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).code).toBe(code);
    expect(fund_next).toHaveBeenCalledTimes(1);
  });

  it("maps a Paused failure at submission to PausedError and sends once", async () => {
    const tx = failingSendTx(new Error("transaction failed: Error(Contract, #38)"));
    const client = makeClient({ contractClient: () => ({ fund_next: async () => tx }) });
    expect(await rejectionOf(client.fundNext(4n, { source: keeper }))).toBeInstanceOf(PausedError);
    expect(tx.send).toHaveBeenCalledTimes(1);
  });
});

describe("cancelSchedule", () => {
  it("calls cancel_schedule as the payer", async () => {
    const tx = sendableTx(undefined, "cancel-hash");
    const cancel_schedule = vi.fn(async (_args: Record<string, unknown>) => tx);
    const client = makeClient({ contractClient: () => ({ cancel_schedule }) });

    const result = await client.cancelSchedule({ scheduleId: 4n, payer });

    expect(result).toEqual({ txHash: "cancel-hash" });
    expect(cancel_schedule).toHaveBeenCalledWith({ schedule_id: 4n, payer: payer.publicKey() });
    expectMatchesSpec("cancel_schedule", cancel_schedule.mock.calls[0][0]);
    expect(tx.unwrap).toHaveBeenCalledTimes(1);
  });

  it.each([
    [3, UnauthorizedError],
    [57, ScheduleCancelledError],
  ])("surfaces contract error %i as a typed error", async (code, ErrorClass) => {
    const client = makeClient({
      contractClient: () => ({
        cancel_schedule: async () => {
          throw new Error(`Error(Contract, #${code})`);
        },
      }),
    });
    expect(await rejectionOf(client.cancelSchedule({ scheduleId: 4n, payer }))).toBeInstanceOf(ErrorClass);
  });
});

describe("approveScheduleAllowance", () => {
  it.each([
    [{ amount: -1n }, /amount/],
    [{ expirationLedger: -1 }, /expirationLedger/],
    [{ expirationLedger: 1.5 }, /expirationLedger/],
    [{ expirationLedger: 2 ** 32 }, /expirationLedger/],
  ])("rejects %o before any network call", async (overrides, message) => {
    const invoke = vi.fn();
    const client = makeClient({ invoke });
    await expect(
      client.approveScheduleAllowance({ payer, token: TOKEN, amount: 1_000n, expirationLedger: 500, ...overrides }),
    ).rejects.toThrow(message);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("invokes the token's approve(from = payer, spender = escrow contract, amount, expiration)", async () => {
    let built: (() => Promise<unknown>) | undefined;
    const invoke = vi.fn(async (method: string, _id: unknown, build: () => Promise<unknown>) => {
      built = build;
      expect(method).toBe("approve");
      return { sendTransactionResponse: { hash: "approve-hash" } };
    });
    const client = makeClient({ invoke }, CONTRACT_ID);

    const result = await client.approveScheduleAllowance({ payer, token: TOKEN, amount: 3_000n, expirationLedger: 900 });

    expect(result).toEqual({ txHash: "approve-hash" });
    expect(invoke).toHaveBeenCalledTimes(1);

    // Run the build step against a spy to see the exact SEP-41 call.
    const build = vi.spyOn(AssembledTransaction, "build").mockResolvedValue("built" as never);
    try {
      await expect(built!()).resolves.toBe("built");
      const options = build.mock.calls[0][0];
      expect(options.contractId).toBe(TOKEN);
      expect(options.method).toBe("approve");
      expect(options.publicKey).toBe(payer.publicKey());
      const args = options.args ?? [];
      expect(args.map((arg) => arg.switch().name)).toEqual(["scvAddress", "scvAddress", "scvI128", "scvU32"]);
      expect(args.map((arg) => scValToNative(arg))).toEqual([payer.publicKey(), CONTRACT_ID, 3_000n, 900]);
    } finally {
      build.mockRestore();
    }
  });
});

describe("scheduleState", () => {
  it("is waiting one second before next_due and due exactly at it (fund_next uses <)", () => {
    expect(scheduleState(schedule({ nextDue: 1_000n }), 999n)).toBe("waiting");
    expect(scheduleState(schedule({ nextDue: 1_000n }), 1_000n)).toBe("due");
    expect(scheduleState(schedule({ nextDue: 1_000n }), 1_001n)).toBe("due");
  });

  it("is due again right after a late fund, because next_due advances by one period", () => {
    // Keeper runs at t=1_250 with next_due=1_000, period=100: one period funded,
    // next_due becomes 1_100, which is still in the past.
    const afterLateFund = schedule({ periodsFunded: 1, nextDue: 1_100n });
    expect(scheduleState(afterLateFund, 1_250n)).toBe("due");
    const afterSecond = schedule({ periodsFunded: 2, nextDue: 1_200n });
    expect(scheduleState(afterSecond, 1_250n)).toBe("due");
  });

  it("is complete once periodsFunded reaches totalPeriods, whatever the clock says", () => {
    expect(scheduleState(schedule({ periodsFunded: 3, totalPeriods: 3, nextDue: 1_300n }), 5_000n)).toBe("complete");
    expect(scheduleState(schedule({ periodsFunded: 3, totalPeriods: 3, nextDue: 1_300n }), 0n)).toBe("complete");
    expect(scheduleState(schedule({ periodsFunded: 2, totalPeriods: 3 }), 5_000n)).toBe("due");
  });

  it("reports cancelled before complete, matching fund_next's check order", () => {
    expect(scheduleState(schedule({ cancelled: true }), 5_000n)).toBe("cancelled");
    expect(scheduleState(schedule({ cancelled: true, periodsFunded: 3, totalPeriods: 3 }), 0n)).toBe("cancelled");
  });
});

describe("allowance helpers", () => {
  it("needs the remaining periods times the amount", () => {
    expect(scheduleAllowanceNeeded(schedule({ amount: 250n, totalPeriods: 12, periodsFunded: 0 }))).toBe(3_000n);
    expect(scheduleAllowanceNeeded(schedule({ amount: 250n, totalPeriods: 12, periodsFunded: 5 }))).toBe(1_750n);
    expect(scheduleAllowanceNeeded(schedule({ amount: 250n, totalPeriods: 12, periodsFunded: 12 }))).toBe(0n);
  });

  it("needs nothing for a cancelled schedule", () => {
    expect(scheduleAllowanceNeeded(schedule({ cancelled: true }))).toBe(0n);
    expect(remainingPeriods(schedule({ cancelled: true }))).toBe(0);
  });

  it("keeps i128 precision for large amounts", () => {
    const amount = 10n ** 30n;
    expect(scheduleAllowanceNeeded(schedule({ amount, totalPeriods: 1_000, periodsFunded: 1 }))).toBe(999n * amount);
  });

  it("estimates an expiration ledger covering the last due time plus a margin", () => {
    const latest = { sequence: 10_000, closeTime: 1_000n };
    // 3 remaining, period 100 → last due at 1_200: 200 s ahead = 40 ledgers at 5 s.
    expect(scheduleAllowanceExpirationLedger(schedule(), latest, { marginLedgers: 0 })).toBe(10_040);
    expect(scheduleAllowanceExpirationLedger(schedule(), latest, { marginLedgers: 10 })).toBe(10_050);
    // Default margin is one day of 5 s ledgers.
    expect(scheduleAllowanceExpirationLedger(schedule(), latest)).toBe(10_040 + 17_280);
    // Overdue periods add nothing beyond the margin.
    expect(scheduleAllowanceExpirationLedger(schedule({ nextDue: 0n, periodSeconds: 1n }), latest, { marginLedgers: 0 })).toBe(10_000);
    expect(scheduleAllowanceExpirationLedger(schedule({ cancelled: true }), latest)).toBe(10_000);
    expect(() => scheduleAllowanceExpirationLedger(schedule(), latest, { secondsPerLedger: 0 })).toThrow(RangeError);
  });
});
