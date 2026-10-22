/**
 * Offline unit tests for `availableActions`, the SDK's pure mirror of the
 * contract's transition rules (Phase E6, issue #73, docs/adr/0009).
 *
 * These are the SDK-side half of the matrix the contract tests in
 * `contracts/escrow/tests/dispute.rs` exercise against the real contract:
 * whenever `availableActions` offers an action, the corresponding contract
 * call must be accepted for that role/status pair. No RPC calls here, so this
 * suite is CI-safe.
 */
import { describe, expect, it } from "vitest";
import { availableActions, type Escrow } from "../src/index.js";

const PAYER = "GPAYER";
const PAYEE = "GPAYEE";
const RELEASER = "GRELEASER";
const ARBITER = "GARBITER";
const STRANGER = "GSTRANGER";

function escrow(overrides: Partial<Escrow> = {}): Escrow {
  return {
    payer: PAYER,
    payee: PAYEE,
    token: "CTOKEN",
    amount: 1_000n,
    conditionRef: "condition",
    releasers: [RELEASER],
    threshold: 1,
    notifyPayee: false,
    arbiter: ARBITER,
    status: "Funded",
    ...overrides,
  };
}

const NO_DEADLINE = 1_000_000n;

describe("availableActions — Funded", () => {
  it("offers a single releaser the direct settlement paths and a dispute", () => {
    expect(availableActions(escrow(), RELEASER, NO_DEADLINE)).toEqual([
      "release",
      "refund",
      "raiseDispute",
    ]);
  });

  it("withholds release/refund from a releaser in a quorum escrow", () => {
    const quorum = escrow({ releasers: [RELEASER, STRANGER], threshold: 2 });

    expect(availableActions(quorum, RELEASER, NO_DEADLINE)).toEqual(["raiseDispute"]);
  });

  it("lets payer and payee open a dispute but not settle directly", () => {
    expect(availableActions(escrow(), PAYER, NO_DEADLINE)).toEqual(["raiseDispute"]);
    expect(availableActions(escrow(), PAYEE, NO_DEADLINE)).toEqual(["raiseDispute"]);
  });

  it("offers a stranger nothing before the timeout", () => {
    expect(availableActions(escrow({ refundAfter: 500n }), STRANGER, 499n)).toEqual([]);
  });

  it("offers anyone the timeout refund at and after the deadline", () => {
    const withDeadline = escrow({ refundAfter: 500n });

    expect(availableActions(withDeadline, STRANGER, 500n)).toEqual(["refund"]);
    expect(availableActions(withDeadline, STRANGER, 900n)).toEqual(["refund"]);
  });

  it("never offers the timeout refund without a deadline", () => {
    expect(availableActions(escrow(), STRANGER, 10n ** 12n)).toEqual([]);
  });
});

describe("availableActions — Disputed", () => {
  it("offers the arbiter the resolution before a split is recorded", () => {
    expect(availableActions(escrow({ status: "Disputed" }), ARBITER, NO_DEADLINE)).toEqual([
      "resolveDispute",
    ]);
  });

  it("does not offer the arbiter a second resolution once one is recorded", () => {
    const resolved = escrow({
      status: "Disputed",
      splitBps: { payerBps: 4_000, payeeBps: 6_000 },
    });

    expect(availableActions(resolved, ARBITER, NO_DEADLINE)).toEqual(["settle"]);
  });

  it("never offers resolution to a non-arbiter", () => {
    const disputed = escrow({ status: "Disputed" });

    for (const address of [PAYER, PAYEE, RELEASER, STRANGER]) {
      expect(availableActions(disputed, address, NO_DEADLINE)).not.toContain("resolveDispute");
    }
  });

  it("offers settlement to anyone once a split exists", () => {
    const resolved = escrow({
      status: "Disputed",
      splitBps: { payerBps: 10_000, payeeBps: 0 },
    });

    expect(availableActions(resolved, STRANGER, NO_DEADLINE)).toEqual(["settle"]);
  });

  it("offers nobody a resolution when the escrow has no arbiter", () => {
    const disputed = escrow({ status: "Disputed", arbiter: undefined });

    for (const address of [PAYER, PAYEE, RELEASER, STRANGER]) {
      expect(availableActions(disputed, address, NO_DEADLINE)).toEqual([]);
    }
  });

  it("freezes the direct settlement paths while disputed", () => {
    const disputed = escrow({ status: "Disputed", refundAfter: 1n });

    for (const address of [RELEASER, STRANGER]) {
      const actions = availableActions(disputed, address, NO_DEADLINE);
      expect(actions).not.toContain("release");
      expect(actions).not.toContain("refund");
      expect(actions).not.toContain("raiseDispute");
    }
  });
});

describe("availableActions — terminal states", () => {
  it("offers nothing on a released or refunded escrow", () => {
    for (const status of ["Released", "Refunded"] as const) {
      for (const address of [PAYER, PAYEE, RELEASER, ARBITER, STRANGER]) {
        expect(availableActions(escrow({ status }), address, NO_DEADLINE)).toEqual([]);
      }
    }
  });
});
