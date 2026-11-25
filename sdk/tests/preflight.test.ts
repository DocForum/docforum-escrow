// Offline tests for the settlement preflight (issue #332) and the remaining
// creation rejections (issue #334). Every case below runs without a network
// call: the pure functions need only data the caller already has, and the
// client-side checks throw before a transaction is built. Each settlement
// case cites the contract test it mirrors.
import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  BatchPartialFailureError,
  EscrowClient,
  EscrowPreconditionError,
  NotFundedError,
  canRefund,
  canRelease,
  type Escrow,
  type SettlementCheck,
} from "../src/index.js";

const payer = Keypair.random();
const payee = Keypair.random();
const releaser = Keypair.random();
const stranger = Keypair.random();
const token = Keypair.random().publicKey();
const contractId = Keypair.random().publicKey();

function escrow(overrides: Partial<Escrow> = {}): Escrow {
  return {
    payer: payer.publicKey(),
    payee: payee.publicKey(),
    token,
    amount: 100n,
    conditionRef: "ref",
    releasers: [releaser.publicKey()],
    threshold: 1,
    notifyPayee: false,
    refundTo: payer.publicKey(),
    requiresAcceptance: false,
    status: "Funded",
    ...overrides,
  };
}

const context = (overrides: Partial<Parameters<typeof canRelease>[1]> = {}) => ({
  caller: releaser.publicKey(),
  ledgerTime: 1_000n,
  ...overrides,
});

/** The first (contract-ordered) reason. */
const first = (check: SettlementCheck) => check.reasons[0];

describe("canRelease", () => {
  it("allows a releaser on a funded escrow", () => {
    // contracts/escrow/tests/release_refund.rs::release_transfers_funds_to_payee_and_marks_released
    expect(canRelease(escrow(), context())).toEqual({ ok: true, reasons: [] });
  });

  it("reports Unauthorized for a stranger", () => {
    // contracts/escrow/tests/release_refund.rs::release_rejects_unauthorized_caller
    const check = canRelease(escrow(), context({ caller: stranger.publicKey() }));
    expect(check).toMatchObject({ ok: false, reason: "Unauthorized" });
  });

  it.each(["Released", "Refunded", "Cancelled"] as const)("reports NotFunded for a %s escrow", (status) => {
    // contracts/escrow/tests/release_refund.rs::release_rejects_double_release
    expect(first(canRelease(escrow({ status }), context()))).toBe("NotFunded");
  });

  it("reports ThresholdNotMet on a quorum escrow, which needs the approval path", () => {
    // contracts/escrow/tests/quorum.rs::single_caller_release_on_a_quorum_escrow_needs_the_approval_path
    const quorum = escrow({ releasers: [releaser.publicKey(), Keypair.random().publicKey()], threshold: 2 });
    expect(first(canRelease(quorum, context()))).toBe("ThresholdNotMet");
  });

  it("reports ReleaseTooEarly before the ledger clock reaches releaseNotBefore", () => {
    // contracts/escrow/tests/time_locked_release.rs::release_is_rejected_before_time_and_allowed_at_the_exact_boundary
    const locked = escrow({ releaseNotBefore: 2_000n });
    expect(first(canRelease(locked, context({ ledgerTime: 1_999n })))).toBe("ReleaseTooEarly");
    expect(canRelease(locked, context({ ledgerTime: 2_000n })).ok).toBe(true);
  });

  it("reports AcceptanceRequired until the payee accepts", () => {
    // contracts/escrow/tests/payee_acceptance.rs::required_acceptance_blocks_release_until_payee_accepts
    const gated = escrow({ requiresAcceptance: true });
    expect(first(canRelease(gated, context()))).toBe("AcceptanceRequired");
    expect(canRelease(escrow({ requiresAcceptance: true, acceptedAt: 1_000n }), context()).ok).toBe(true);
  });

  it("reports FundingIncomplete below the pooled target and allows the exact target", () => {
    // contracts/escrow/tests/pooled.rs::partial_funding_records_and_blocks_release
    // contracts/escrow/tests/pooled.rs::reaching_the_target_releases_the_pooled_total
    const pooled = { fundingTarget: 100n, fundingDeadline: 5_000n };
    expect(first(canRelease(escrow(), context({ pooled })))).toBeUndefined();
    expect(first(canRelease(escrow({ amount: 99n }), context({ pooled })))).toBe("FundingIncomplete");
  });

  it("reports reasons in contract order, so reasons[0] is the contract's error", () => {
    // internal.rs release_checks: caller, then status, then funding.
    const check = canRelease(
      escrow({ status: "Released", amount: 50n }),
      context({ caller: stranger.publicKey(), pooled: { fundingTarget: 100n, fundingDeadline: 5_000n } }),
    );
    expect(check.reasons).toEqual(["Unauthorized", "NotFunded", "FundingIncomplete"]);
  });
});

describe("canRefund", () => {
  it("allows a single releaser before the deadline", () => {
    // contracts/escrow/tests/release_refund.rs::refund_transfers_funds_back_to_payer_and_marks_refunded
    expect(canRefund(escrow({ refundAfter: 2_000n }), context()).ok).toBe(true);
  });

  it("rejects a stranger before the deadline", () => {
    // contracts/escrow/tests/refund_after.rs equivalents: timeout_refund.rs::timeout_refund_rejected_before_deadline
    const check = canRefund(escrow({ refundAfter: 2_000n }), context({ caller: stranger.publicKey() }));
    expect(first(check)).toBe("Unauthorized");
  });

  it("allows anyone at and after the deadline", () => {
    // contracts/escrow/tests/timeout_refund.rs::timeout_refund_by_stranger_succeeds_at_the_exact_deadline
    const timed = escrow({ refundAfter: 2_000n });
    expect(canRefund(timed, context({ caller: stranger.publicKey(), ledgerTime: 2_000n })).ok).toBe(true);
    expect(canRefund(timed, context({ caller: stranger.publicKey(), ledgerTime: 2_001n })).ok).toBe(true);
  });

  it("keeps a stranger out forever without a deadline", () => {
    // contracts/escrow/tests/timeout_refund.rs::without_deadline_stranger_refund_stays_unauthorized_even_forever_after
    expect(first(canRefund(escrow(), context({ caller: stranger.publicKey(), ledgerTime: 10n ** 12n })))).toBe(
      "Unauthorized",
    );
  });

  it("lets the stored payee refund voluntarily, even on a quorum escrow", () => {
    // contracts/escrow/tests/release_refund.rs::payee_can_voluntarily_refund_to_payer_and_emits_distinct_event
    const quorum = escrow({ releasers: [releaser.publicKey(), Keypair.random().publicKey()], threshold: 2 });
    expect(canRefund(quorum, context({ caller: payee.publicKey() })).ok).toBe(true);
  });

  it("reports NotSupportedForPooled for a pooled escrow on either path", () => {
    // contracts/escrow/tests/pooled.rs::push_paths_and_top_up_reject_pooled_escrows
    const pooled = { fundingTarget: 100n, fundingDeadline: 5_000n };
    expect(first(canRefund(escrow(), context({ pooled })))).toBe("NotSupportedForPooled");
    expect(first(canRefund(escrow(), context({ pooled, caller: payee.publicKey() })))).toBe(
      "NotSupportedForPooled",
    );
  });

  it("reports NotFunded to a releaser after settlement, but Unauthorized first for a stranger", () => {
    // contracts/escrow/tests/timeout_refund.rs::timeout_refund_fails_after_release
    // refund_checks runs the caller check before check_funded, so with no
    // deadline a stranger hears Unauthorized first — exactly as on-chain.
    expect(first(canRefund(escrow({ status: "Released" }), context()))).toBe("NotFunded");
    expect(first(canRefund(escrow({ status: "Released" }), context({ caller: stranger.publicKey() })))).toBe(
      "Unauthorized",
    );
    // Past the deadline the caller check is skipped, so the status is next.
    expect(
      first(canRefund(escrow({ status: "Released", refundAfter: 1n }), context({ caller: stranger.publicKey() }))),
    ).toBe("NotFunded");
  });
});

function makeClient(fakes: Record<string, unknown>): EscrowClient {
  return Object.assign(new EscrowClient({ contractId, rpcUrl: "https://127.0.0.1:1" }), fakes);
}

const notPooled = async () => {
  throw new Error("HostError: Error(Contract, #26)");
};

describe("EscrowClient.canRelease / canRefund", () => {
  it("reads the escrow, pooled config and ledger clock", async () => {
    const getEscrow = vi.fn(async () => escrow());
    const getPooled = vi.fn(notPooled);
    const getLedgerTime = vi.fn(async () => ({ closeTime: 1_000n, sequence: 1, offsetMs: 0 }));
    const client = makeClient({ getEscrow, getPooled, getLedgerTime });

    const check = await client.canRelease({ escrowId: 7n, caller: releaser.publicKey() });

    expect(check.ok).toBe(true);
    expect(getEscrow).toHaveBeenCalledWith(7n);
    expect(getPooled).toHaveBeenCalledWith(7n);
    expect(getLedgerTime).toHaveBeenCalledTimes(1);
  });

  it("uses the caller's signer address", async () => {
    const client = makeClient({
      getEscrow: async () => escrow(),
      getPooled: notPooled,
      getLedgerTime: async () => ({ closeTime: 1_000n, sequence: 1, offsetMs: 0 }),
    });
    expect((await client.canRelease({ escrowId: 1n, caller: releaser })).ok).toBe(true);
  });

  it("explains a settled escrow as NotFunded without reading its reclaimed record", async () => {
    const getEscrow = vi.fn(async () => {
      throw new NotFundedError();
    });
    const client = makeClient({ getEscrow });
    expect(await client.canRefund({ escrowId: 1n, caller: stranger })).toEqual({
      ok: false,
      reasons: ["NotFunded"],
      reason: "NotFunded",
    });
  });

  it("refuses a release the contract would reject when checkPreconditions is on", async () => {
    const contractClient = vi.fn();
    const client = makeClient({
      getEscrow: async () => escrow(),
      getPooled: notPooled,
      getLedgerTime: async () => ({ closeTime: 1_000n, sequence: 1, offsetMs: 0 }),
      contractClient,
    });

    const error = await client
      .release({ escrowId: 1n, caller: stranger, checkPreconditions: true })
      .then(() => undefined, (e: unknown) => e);

    expect(error).toBeInstanceOf(EscrowPreconditionError);
    expect(error).toMatchObject({ method: "release", code: "Unauthorized" });
    expect(contractClient).not.toHaveBeenCalled();
  });
});

describe("creation rejections", () => {
  const client = new EscrowClient({ contractId, rpcUrl: "https://127.0.0.1:1" });

  function createParams(overrides: Record<string, unknown> = {}) {
    return {
      payer,
      payee: payee.publicKey(),
      token,
      amount: 100n,
      conditionRef: "creation-checks",
      releaser: releaser.publicKey(),
      ...overrides,
    } as never;
  }

  it.each([0n, -1n])("rejects a non-positive amount %s before simulation", async (amount) => {
    // contracts/escrow/src/internal.rs: `amount <= 0` → InvalidAmount (2)
    await expect(client.createEscrow(createParams({ amount }))).rejects.toThrow(/InvalidAmount \(error 2\)/);
  });

  it("rejects refundTo as the contract's own address", async () => {
    // create.rs: `refund_to == current_contract_address()` → InvalidRefundTo (21)
    await expect(
      client.createEscrow(createParams({ refundTo: contractId }))
    ).rejects.toThrow(/InvalidRefundTo \(error 21\)/);
  });

  it("rejects feeRecipient as the contract's own address", async () => {
    // create.rs: fee recipient equal to the contract → InvalidFee (35)
    await expect(
      client.createEscrow(createParams({ feeRecipient: contractId, feeBps: 100 }))
    ).rejects.toThrow(/InvalidFee \(error 35\)/);
  });

  it("rejects releaseNotBefore after refundAfter", async () => {
    // time_locked_release.rs::creation_rejects_release_time_in_the_past_or_after_refund_deadline
    await expect(
      client.createEscrow(createParams({ refundAfter: 2_000n, releaseNotBefore: 2_001n }))
    ).rejects.toThrow(/InvalidReleaseNotBefore \(error 22\)/);
  });

  it("applies the same checks to a quorum creation", async () => {
    const params = {
      payer,
      payee: payee.publicKey(),
      token,
      amount: 0n,
      conditionRef: "quorum-checks",
      releasers: [releaser.publicKey(), stranger.publicKey()],
      threshold: 2,
    };

    await expect(client.createQuorumEscrow(params as never)).rejects.toThrow(/InvalidAmount \(error 2\)/);
    await expect(
      client.createQuorumEscrow({ ...params, amount: 1n, refundTo: contractId } as never)
    ).rejects.toThrow(/InvalidRefundTo \(error 21\)/);
  });

  it("names the contract errors for pooled creation", async () => {
    // contracts/escrow/tests/pooled.rs::pooled_creation_validation
    const params = {
      creator: payer,
      payee: payee.publicKey(),
      token,
      fundingTarget: 0n,
      conditionRef: "pooled-checks",
      releaser: releaser.publicKey(),
      fundingDeadline: 2_000n,
    };

    await expect(client.createPooledEscrow(params as never)).rejects.toThrow(/InvalidAmount \(error 2\)/);
    await expect(
      client.createPooledEscrow({ ...params, fundingTarget: 1n, fundingDeadline: 0n } as never)
    ).rejects.toThrow(/InvalidFundingDeadline \(error 34\)/);
  });

  it("rejects a bad item in createEscrows without sending anything", async () => {
    const results = client
      .createEscrows([createParams({ amount: 0n })])
      .then(() => undefined, (error: unknown) => error);

    const error = await results;
    expect(error).toBeInstanceOf(BatchPartialFailureError);
    expect((error as BatchPartialFailureError<unknown>).results[0].error).toMatch(/InvalidAmount \(error 2\)/);
  });
});
