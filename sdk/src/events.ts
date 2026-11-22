import { transactionHash } from "./prepare.js";

/** The contract lifecycle event a decoded {@link EscrowEvent} describes. */
export type EscrowEventType = "created" | "released" | "refunded" | "cancelled";
interface EscrowEventBase {
  ledger: number;
  cursor: string;
  transactionHash: string;
  data: unknown;
}
/**
 * Unknown variants are retained with decoded topics so newer contract event
 * schemas remain observable to older SDK consumers instead of crashing.
 */
export type EscrowEvent = (EscrowEventBase & {
  type: EscrowEventType;
  escrowId: bigint;
}) | (EscrowEventBase & {
  type: "unknown";
  eventName?: string;
  escrowId?: bigint;
  topics: unknown[];
});
/**
 * Which events {@link EscrowClient.getEvents} should return and where to start.
 * Begin either from a ledger number (`fromLedger`) or from an opaque RPC
 * `cursor` returned by a prior page — never both — and optionally narrow to
 * specific event `types` and/or one `escrowId`.
 */
export type GetEventsParams = {
  types?: EscrowEventType[];
  escrowId?: bigint;
} & (
  | { /** First ledger to scan (inclusive). */ fromLedger: number; cursor?: never }
  | { /** Opaque RPC cursor returned from a prior page/event. */ cursor: string; fromLedger?: never }
);
/** One page of decoded events plus the cursor to resume from on the next call. */
export interface GetEventsResult { events: EscrowEvent[]; nextCursor: string; }

/** The requested cursor predates the event history retained by the RPC server. */
export class EventCursorExpiredError extends Error {
  readonly name = "EventCursorExpiredError";
  constructor(message = "The event cursor is older than the RPC server's retention window.") { super(message); }
}

/** Tuning for {@link EscrowClient.subscribe}: where to resume, how often to poll, and how to filter and handle errors. */
export interface SubscribeOptions {
  cursor?: string;
  pollIntervalMs?: number;
  types?: EscrowEventType[];
  escrowId?: bigint;
  /** Called with any polling error; if omitted, the error is rethrown and polling stops. */
  onError?: (error: unknown) => void;
}
