import { type EscrowSigner } from "./signers/types.js";

/**
 * Creation parameters for a pooled escrow (issue #113, docs/adr/0011): one
 * agreement funded by many payers. Creation funds nothing — `contribute`
 * does, before `fundingDeadline`, up to `fundingTarget`.
 */
export interface CreatePooledEscrowParams {
  /** Signs and pays for creation; funds nothing at this step. */
  creator: EscrowSigner;
  payee: string;
  token: string;
  /**
   * Raw token units the contributors must reach before `release` becomes
   * possible. Must be positive; fixed at creation, never changed.
   */
  fundingTarget: bigint;
  conditionRef: string;
  /** The address permitted to `release` the fully funded pool (docs/adr/0002). */
  releaser: string;
  /**
   * Unix seconds after which contributions are rejected forever and, if
   * the target was missed, `claimRefund` opens to every contributor.
   * Must be strictly in the future (contract error
   * `InvalidFundingDeadline`, 34).
   */
  fundingDeadline: bigint;
  /**
   * Optional unix-seconds release deadline (issue #288). Once it passes on a
   * pool that hasn't been released, contributors can `claimRefund` even if
   * the pool reached its target, so a lost releaser key can't lock the pool
   * forever. Must be strictly after `fundingDeadline` (contract error
   * `InvalidReleaseDeadline`). When set, creation calls
   * `create_pooled_release_deadline`; when omitted it calls
   * `create_pooled_escrow` exactly as before.
   */
  releaseDeadline?: bigint;
}

/** Options for {@link EscrowClient.closeFailedRound}. */
export interface CloseFailedRoundOptions {
  /** Pays the fee. The call is permissionless: anyone may close an empty failed round. */
  source: EscrowSigner;
}

/** Parameters for {@link EscrowClient.contribute} — one payer funds part of a pooled escrow. */
export interface ContributeParams {
  escrowId: bigint;
  /** Signs the transfer; the funds come from this account. */
  payer: EscrowSigner;
  /** Raw token units; positive, and only while the pool is under target. */
  amount: bigint;
}

/** Pull-based refund params — the contributor claims their own record. */
export interface ClaimRefundParams {
  escrowId: bigint;
  /** Must be the recorded contributor; signs the claim (docs/adr/0011). */
  contributor: EscrowSigner;
}

/** Read-only funding config of a pooled escrow (`getPooled`). */
export interface PooledEscrow {
  fundingTarget: bigint;
  fundingDeadline: bigint;
  /**
   * Unix seconds after which contributors may `claimRefund` even from a fully
   * funded, unreleased pool (issue #288). `undefined` when the pool has no
   * release deadline, or the deployment predates the field.
   */
  releaseDeadline?: bigint;
}

/**
 * Per-token solvency reading (`getSolvency`, issue #39). `liabilities` is
 * the on-chain sum of `amount` over every `Funded` escrow in that token.
 */
export interface SolvencyReport {
  /** The escrow contract's current balance of the token. */
  balance: bigint;
  /** Total the contract owes in that token across all `Funded` escrows. */
  liabilities: bigint;
  /** `balance >= liabilities`. */
  solvent: boolean;
}

/** One contributor's record on a pooled escrow (`getContribution`). */
export interface ContributionRecord {
  /** Total accepted contributions from this address — claimable if not `refunded`. */
  amount: bigint;
  /** True once `claimRefund` has paid this record; a second claim fails. */
  refunded: boolean;
}

/** Phase of a pooled escrow round (`pooledPhase`, `getPooledPhase`, issue #331). */
export type PooledPhase = "open" | "funded" | "failed" | "released";

/** Combined phase, remaining target, and deadline for a pooled escrow. */
export interface PooledPhaseInfo {
  phase: PooledPhase;
  /** Remaining amount needed to reach `fundingTarget` (`0n` once funded). */
  remaining: bigint;
  /** Funding deadline in unix seconds (`fundingDeadline`). */
  deadline: bigint;
}

/**
 * Pure helper: computes a pooled escrow's phase from its `escrow` state,
 * `pooled` config, and `ledgerTime` (latest ledger close time in unix seconds,
 * not the local wall clock). Matches the contract's `>=` deadline boundary
 * in `contribute` and `claim_refund`.
 */
export function pooledPhase(
  escrow: { status: "Funded" | "Released" | "Refunded" | "Cancelled"; amount: bigint },
  pooled: Pick<PooledEscrow, "fundingTarget" | "fundingDeadline">,
  ledgerTime: bigint,
): PooledPhaseInfo {
  const remaining = pooled.fundingTarget > escrow.amount ? pooled.fundingTarget - escrow.amount : 0n;
  const deadline = pooled.fundingDeadline;

  let phase: PooledPhase;
  if (escrow.status === "Released") {
    phase = "released";
  } else if (escrow.status === "Refunded" || escrow.status === "Cancelled") {
    phase = "failed";
  } else if (escrow.amount >= pooled.fundingTarget) {
    phase = "funded";
  } else if (ledgerTime >= pooled.fundingDeadline) {
    phase = "failed";
  } else {
    phase = "open";
  }

  return { phase, remaining, deadline };
}
