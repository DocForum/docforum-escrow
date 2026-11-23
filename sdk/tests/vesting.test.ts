import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  EscrowClient,
  timelineOf,
  validateVestingSchedule,
  vestedAt,
} from "../src/index.js";

const payer = Keypair.random();
const payee = Keypair.random();

function makeClient(fakes: Record<string, unknown>): EscrowClient {
  return Object.assign(
    new EscrowClient({ contractId: Keypair.random().publicKey(), rpcUrl: "https://127.0.0.1:1" }),
    fakes,
  );
}

function stream(amount = 100n) {
  return { amount, schedule: { start: 100n, cliff: 130n, end: 200n } };
}

describe("vesting helpers", () => {
  it("matches contract boundaries and integer remainder math", () => {
    expect(vestedAt(stream(), 99n)).toBe(0n);
    expect(vestedAt(stream(), 129n)).toBe(0n);
    expect(vestedAt(stream(), 130n)).toBe(30n);
    expect(vestedAt(stream(7n), 103n)).toBe(0n);
    expect(vestedAt({ amount: 7n, schedule: { start: 100n, end: 110n } }, 103n)).toBe(2n);
    expect(vestedAt(stream(), 200n)).toBe(100n);
  });

  it("reports unique schedule milestones and incremental unlocks", () => {
    expect(timelineOf(stream())).toEqual([
      { kind: "start", timestamp: 100n, vestedAmount: 0n, unlocks: 0n },
      { kind: "cliff", timestamp: 130n, vestedAmount: 30n, unlocks: 30n },
      { kind: "end", timestamp: 200n, vestedAmount: 100n, unlocks: 70n },
    ]);
  });

  it.each([
    [{ start: 10n, end: 10n }, "start must be before end"],
    [{ start: 11n, end: 10n }, "start must be before end"],
    [{ start: 10n, cliff: 9n, end: 20n }, "cliff must be between start and end"],
    [{ start: 10n, cliff: 21n, end: 20n }, "cliff must be between start and end"],
  ])("rejects invalid schedule %#", (schedule, message) => {
    expect(() => validateVestingSchedule(schedule)).toThrow(message);
  });
});

describe("EscrowClient time-based methods", () => {
  it("creates a stream with the contract's schedule shape", async () => {
    const tx = { result: { unwrap: () => 12n }, sendTransactionResponse: { hash: "stream-hash" } };
    const create_streamed_escrow = vi.fn(async () => tx);
    const client = makeClient({
      contractClient: () => ({ create_streamed_escrow }),
      invoke: async (_method: string, _id: bigint | undefined, build: () => Promise<unknown>) => {
        await build();
        return tx;
      },
    });

    const result = await client.createStreamedEscrow({
      payer,
      payee: payee.publicKey(),
      token: Keypair.random().publicKey(),
      amount: 100n,
      conditionRef: "stream",
      releaser: payer.publicKey(),
      schedule: { start: 100n, cliff: 130n, end: 200n },
    });

    expect(result).toEqual({ escrowId: 12n, txHash: "stream-hash" });
    expect(create_streamed_escrow).toHaveBeenCalledWith(expect.objectContaining({
      schedule: { start: 100n, cliff: 130n, end: 200n },
    }));
  });

  it("maps get_vesting to the public camelCase shape", async () => {
    const get_vesting = vi.fn(async () => ({
      result: {
        unwrap: () => ({
          schedule: { start: 100n, cliff: null, end: 200n },
          total_amount: 100n,
          vested_amount: 40n,
          withdrawn_amount: 10n,
          claimable_amount: 30n,
        }),
      },
    }));
    const client = makeClient({
      ensureNetworkVerified: async () => {},
      contractClient: () => ({ get_vesting }),
    });

    await expect(client.getVesting(12n)).resolves.toEqual({
      schedule: { start: 100n, end: 200n, cliff: undefined },
      totalAmount: 100n,
      vestedAmount: 40n,
      withdrawnAmount: 10n,
      claimableAmount: 30n,
    });
    expect(get_vesting).toHaveBeenCalledWith({ escrow_id: 12n });
  });

  it("withdraws as the stream payee and returns the vested amount", async () => {
    const tx = { result: { unwrap: () => 30n }, sendTransactionResponse: { hash: "withdraw-hash" } };
    const withdraw = vi.fn(async () => tx);
    const client = makeClient({
      contractClient: () => ({ withdraw }),
      invoke: async (_method: string, _id: bigint | undefined, build: () => Promise<unknown>) => {
        await build();
        return tx;
      },
    });

    await expect(client.withdraw({ escrowId: 12n, payee })).resolves.toEqual({
      amount: 30n,
      txHash: "withdraw-hash",
    });
    expect(withdraw).toHaveBeenCalledWith({ escrow_id: 12n, payee: payee.publicKey() });
  });
});
