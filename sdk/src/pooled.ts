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
  /**
   * Free-form reference bounded to 64 UTF-8 bytes on-chain
   * (`MAX_CONDITION_REF_LEN`). Length is measured with `utf8ByteLength`,
   * not `String.length`.
   */
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
