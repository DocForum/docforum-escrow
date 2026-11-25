// Client-side preflight checks: explain a settlement (issue #332) or reject a
// malformed creation (issue #334) before a wallet is opened. Both mirror
// `contracts/escrow/src/` so the reported reason is the error the contract
// would return. The contract stays the authority — a passing check can still
// fail on-chain, e.g. from a race, a lying token or a rotated releaser.
import { type Escrow } from "./escrow-types.js";
import { type PooledEscrow } from "./pooled.js";
import { type EscrowSigner } from "./signers/types.js";

/**
 * A contract error name a settlement preflight can report. Each is the name of
 * the matching `Error` variant in `contracts/escrow/src/errors.rs`.
 */
export type SettlementReason =
  /** The caller is not one of the escrow's `releasers` (`Unauthorized`, 3). */
  | "Unauthorized"
  /** The caller is a releaser, but the escrow needs approvals (`ThresholdNotMet`, 15). */
  | "ThresholdNotMet"
  /** The escrow has already settled (`NotFunded`, 4). */
  | "NotFunded"
  /** A pooled escrow below its funding target can never release (`FundingIncomplete`, 29). */
  | "FundingIncomplete"
  /** `releaseNotBefore` has not been reached on the ledger clock yet (`ReleaseTooEarly`, 23). */
  | "ReleaseTooEarly"
  /** The payee has not accepted a `requiresAcceptance` escrow (`AcceptanceRequired`, 18). */
  | "AcceptanceRequired"
  /** Push refunds do not exist for pooled escrows (`NotSupportedForPooled`, 33). */
  | "NotSupportedForPooled";

/** The outcome of a settlement preflight. */
export interface SettlementCheck {
  /** True when the contract would accept the call as far as these checks go. */
  ok: boolean;
  /**
   * Contract error names, in the order the contract checks them. Empty when
   * `ok`. The contract short-circuits, so `reasons[0]` is the error it would
   * return right now; later entries are additional issues it would reach only
   * after the first were fixed.
   */
  reasons: SettlementReason[];
  /** The first reason — exactly what the contract would return. Absent when `ok`. */
  reason?: SettlementReason;
}

/** Everything a settlement preflight needs besides the escrow itself. */
export interface SettlementContext {
  /** Address that would sign the `release`/`refund` call. */
  caller: string;
  /**
   * Ledger close time in unix seconds — the clock the contract compares every
   * deadline against. Use {@link EscrowClient.getLedgerTime} rather than the
   * local clock.
   */
  ledgerTime: bigint;
  /** The pooled funding config (`getPooled`) when the escrow is pooled. */
  pooled?: PooledEscrow | null;
}

/** Parameters for {@link EscrowClient.canRelease} and {@link EscrowClient.canRefund}. */
export interface SettlementCheckParams {
  /** The escrow to explain. */
  escrowId: bigint;
  /** Address that would sign the call; a signer or its `G…` address. */
  caller: EscrowSigner | string;
  /**
   * Ledger close time in unix seconds. Default: one cached
   * {@link EscrowClient.getLedgerTime} read.
   */
  ledgerTime?: bigint;
  /**
   * Pooled funding config. Omitted: read with `getPooled` (one extra read).
   * Pass `null` when the escrow is known not to be pooled.
   */
  pooled?: PooledEscrow | null;
}

function result(reasons: SettlementReason[]): SettlementCheck {
  if (reasons.length === 0) return { ok: true, reasons };
  return { ok: false, reasons, reason: reasons[0] };
}

/**
 * Would `release` succeed? Pure and offline: mirrors the order of
 * `release_checks` (`contracts/escrow/src/internal.rs`), then the
 * `release_not_before` and payee-acceptance gates in `settle_full`, then the
 * pooled check. Returns every reason found, in that order.
 */
export function canRelease(escrow: Escrow, context: SettlementContext): SettlementCheck {
  const reasons: SettlementReason[] = [];
  // release_checks → check_single_caller: the caller must be a releaser, and a
  // quorum escrow needs `release_with_approvals` instead.
  if (!escrow.releasers.includes(context.caller)) reasons.push("Unauthorized");
  else if (escrow.threshold !== 1) reasons.push("ThresholdNotMet");
  // check_funded.
  if (escrow.status !== "Funded") reasons.push("NotFunded");
  // check_pooled_fully_funded: a partial pool can never release.
  if (context.pooled && escrow.amount !== context.pooled.fundingTarget) reasons.push("FundingIncomplete");
  // settle_full: the earliest-release time, then the acceptance gate.
  if (escrow.releaseNotBefore !== undefined && context.ledgerTime < escrow.releaseNotBefore) {
    reasons.push("ReleaseTooEarly");
  }
  if (escrow.requiresAcceptance && escrow.acceptedAt === undefined) reasons.push("AcceptanceRequired");
  return result(reasons);
}

/**
 * Would `refund` succeed? Pure and offline: mirrors `refund_checks_for_caller`
 * (`contracts/escrow/src/internal.rs`). Three paths, in the contract's order:
 * the stored payee may always voluntarily refund a funded escrow (no releaser
 * or threshold check); otherwise pooled escrows are rejected; otherwise the
 * caller must be a single releaser, unless `refundAfter` has passed, when
 * anyone may refund — always to the stored `refundTo`.
 */
export function canRefund(escrow: Escrow, context: SettlementContext): SettlementCheck {
  const reasons: SettlementReason[] = [];
  if (context.caller === escrow.payee) {
    // Payee-initiated voluntary refund: funded and non-pooled, nothing else.
    if (context.pooled) reasons.push("NotSupportedForPooled");
    if (escrow.status !== "Funded") reasons.push("NotFunded");
    return result(reasons);
  }
  // reject_pooled: pooled refunds are pull-based (`claimRefund`).
  if (context.pooled) reasons.push("NotSupportedForPooled");
  // The timeout path skips the caller check entirely.
  const timeoutPassed = escrow.refundAfter !== undefined && context.ledgerTime >= escrow.refundAfter;
  if (!timeoutPassed) {
    if (!escrow.releasers.includes(context.caller)) reasons.push("Unauthorized");
    else if (escrow.threshold !== 1) reasons.push("ThresholdNotMet");
  }
  if (escrow.status !== "Funded") reasons.push("NotFunded");
  return result(reasons);
}
