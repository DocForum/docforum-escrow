// Structural views of the SDK client. Importing the SDK's *types* keeps this
// package honest without forcing a runtime dependency on the SDK build; any
// object that implements these methods works (including `EscrowClient`).
import type {
  ContributionRecord,
  CreateEscrowParams,
  CreateQuorumEscrowParams,
  Escrow,
  EscrowClient,
  EscrowEvent,
  EscrowEventType,
  EscrowPreconditionCode,
  EscrowSigner,
  EscrowStatus,
  PooledEscrow,
  ReleaseOrRefundParams,
  SettlementApprovalsParams,
} from "@docforum/escrow-sdk";

export type { Escrow, EscrowSigner, EscrowStatus };
export type {
  ContributionRecord,
  CreateEscrowParams,
  CreateQuorumEscrowParams,
  EscrowEvent,
  EscrowEventType,
  EscrowPreconditionCode,
  PooledEscrow,
  ReleaseOrRefundParams,
  SettlementApprovalsParams,
};

/**
 * The subset of `EscrowClient` the hooks need.
 *
 * `subscribe` stays optional so a partial client (for example a fake in
 * tests, or an older adapter) keeps working with the query and action hooks;
 * only `useEscrowEvents` needs it and reports its absence as state.
 */
export type EscrowClientLike = Pick<
  EscrowClient,
  | "getEscrow"
  | "getStatus"
  | "createEscrow"
  | "createQuorumEscrow"
  | "release"
  | "refund"
  | "releaseWithApprovals"
  | "refundWithApprovals"
  | "accept"
  | "cancel"
  | "topUp"
  | "contribute"
  | "claimRefund"
  | "getPooled"
  | "getContribution"
> & {
  subscribe?: EscrowClient["subscribe"];
};

/** A single escrow's settlement transaction hash. */
export interface TxResult {
  txHash: string;
}

/** Result of creating an escrow. */
export interface CreateResult {
  escrowId: bigint;
  txHash: string;
}

/**
 * The structural shape of the SDK's `EscrowPreconditionError` (a client-side
 * check that refused a lifecycle call before building a transaction). The
 * hooks identify it by `name`, so no runtime import of the SDK is required.
 */
export interface EscrowPreconditionErrorInfo {
  readonly name: "EscrowPreconditionError";
  /** Which rule refused the call, e.g. `AlreadyAccepted` or `NotFunded`. */
  readonly code: EscrowPreconditionCode;
  /** The contract function the call would have invoked. */
  readonly method: string;
  readonly message: string;
}

/**
 * How much of a pooled escrow's funding round is complete:
 *
 * - `open` — before the deadline, still below the target.
 * - `funded` — the target is reached; the releaser may release at any time.
 * - `failed` — the deadline passed below the target (contributions frozen,
 *   `claimRefund` open forever), or the round already closed as refunded.
 * - `released` — the escrow settled as `Released`; the payout is final.
 */
export type PooledEscrowPhase = "open" | "funded" | "failed" | "released";
