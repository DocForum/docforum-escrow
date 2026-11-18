// @docforum/escrow-react — framework glue only: hooks, cache keys and types.
// No UI components, no styling, no contract logic.
export {
  EscrowProvider,
  useEscrowContext,
  DEFAULT_POLL_INTERVAL_MS,
  type EscrowProviderProps,
  type EscrowClientContextValue,
} from "./context.js";
export { useEscrow, type UseEscrowOptions } from "./useEscrow.js";
export {
  useEscrowActions,
  type CreateEscrowActionParams,
  type CreateQuorumEscrowActionParams,
  type EscrowActionResult,
} from "./useEscrowActions.js";
export {
  useEscrowTimeline,
  type EscrowTimeline,
  type UseEscrowTimelineOptions,
} from "./useEscrowTimeline.js";
export { escrowKeys } from "./queryKeys.js";
export { isTerminalStatus, isUserRejection } from "./errors.js";
export type {
  CreateEscrowParams,
  CreateQuorumEscrowParams,
  CreateResult,
  Escrow,
  EscrowClientLike,
  EscrowSigner,
  EscrowStatus,
  ReleaseOrRefundParams,
  SettlementApprovalsParams,
  TxResult,
} from "./types.js";
