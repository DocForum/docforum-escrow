// Structural views of the SDK client. Importing the SDK's *types* keeps this
// package honest without forcing a runtime dependency on the SDK build; any
// object that implements these methods works (including `EscrowClient`).
import type {
  CreateEscrowParams,
  CreateQuorumEscrowParams,
  Escrow,
  EscrowClient,
  EscrowSigner,
  EscrowStatus,
  ReleaseOrRefundParams,
  SettlementApprovalsParams,
} from "@docforum/escrow-sdk";

export type { Escrow, EscrowSigner, EscrowStatus };
export type { CreateEscrowParams, CreateQuorumEscrowParams, ReleaseOrRefundParams, SettlementApprovalsParams };

/** The subset of `EscrowClient` the hooks need. */
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
>;

/** A single escrow's settlement transaction hash. */
export interface TxResult {
  txHash: string;
}

/** Result of creating an escrow. */
export interface CreateResult {
  escrowId: bigint;
  txHash: string;
}
