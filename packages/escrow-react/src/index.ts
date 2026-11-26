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
export {
  usePooledEscrow,
  useContribution,
  pooledEscrowPhase,
  type PooledEscrowSnapshot,
  type UsePooledEscrowOptions,
  type UsePooledEscrowResult,
  type UseContributionOptions,
} from "./pooled.js";
export {
  useEscrowEvents,
  DEFAULT_MAX_EVENTS,
  type EscrowEventsState,
  type UseEscrowEventsOptions,
} from "./useEscrowEvents.js";
export { escrowKeys } from "./queryKeys.js";
export {
  asError,
  isEscrowPreconditionError,
  isEventCursorExpiredError,
  isTerminalStatus,
  isUserRejection,
} from "./errors.js";
export type {
  ContributionRecord,
  CreateEscrowParams,
  CreateQuorumEscrowParams,
  CreateResult,
  Escrow,
  EscrowClientLike,
  EscrowEvent,
  EscrowEventType,
  EscrowPreconditionCode,
  EscrowPreconditionErrorInfo,
  EscrowSigner,
  EscrowStatus,
  PooledEscrow,
  PooledEscrowPhase,
  ReleaseOrRefundParams,
  SettlementApprovalsParams,
  TxResult,
} from "./types.js";
