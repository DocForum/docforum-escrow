import { transactionHash } from "./prepare.js";

/** The contract lifecycle events that share one escrow-state snapshot payload. */
export type EscrowLifecycleEventType = "created" | "released" | "refunded" | "cancelled";

/** The contract event a decoded {@link EscrowEvent} describes. */
export type EscrowEventType =
  | EscrowLifecycleEventType
  | "topUp"
  | "accepted"
  | "rotated"
  | "payeeTransferred"
  | "contributed"
  | "claimed"
  | "payeeRefunded"
  | "settled"
  | "refundDeadlineExtended"
  | "paused"
  | "unpaused";

interface EscrowEventBase {
  ledger: number;
  cursor: string;
  transactionHash: string;
  /** The event's data payload, as native values (kept for every variant). */
  data: unknown;
}

/** `top_up`: the payer added `amount`; the escrow now holds `newAmount`. */
export interface TopUpEvent extends EscrowEventBase { type: "topUp"; escrowId: bigint; amount: bigint; newAmount: bigint }
/** `accepted`: the payee accepted the escrow at ledger time `acceptedAt` (unix seconds). */
export interface AcceptedEvent extends EscrowEventBase { type: "accepted"; escrowId: bigint; payee: string; acceptedAt: bigint }
/** `rotate`: the releaser changed from `oldReleaser` to `newReleaser`. */
export interface RotatedEvent extends EscrowEventBase { type: "rotated"; escrowId: bigint; oldReleaser: string; newReleaser: string }
/** `pay_xfer`: the payee role moved from `oldPayee` to `newPayee`. */
export interface PayeeTransferredEvent extends EscrowEventBase { type: "payeeTransferred"; escrowId: bigint; oldPayee: string; newPayee: string }
/** `contrib`: `contributor` added `amount` to a pooled escrow, which now holds `funded`. */
export interface ContributedEvent extends EscrowEventBase { type: "contributed"; escrowId: bigint; contributor: string; amount: bigint; funded: bigint }
/** `claimed`: `contributor` reclaimed `amount` from a pooled escrow that did not settle. */
export interface ClaimedEvent extends EscrowEventBase { type: "claimed"; escrowId: bigint; contributor: string; amount: bigint }
/** `PayeeRefunded`: the payee voluntarily refunded `amount` to the payer. */
export interface PayeeRefundedEvent extends EscrowEventBase { type: "payeeRefunded"; escrowId: bigint; payer: string; payee: string; amount: bigint }
/** `settled`: a split settlement paid `payeeAmount` to the payee and `payerAmount` back to the payer. */
export interface SettledEvent extends EscrowEventBase { type: "settled"; escrowId: bigint; payeeAmount: bigint; payerAmount: bigint }
/** `RefundDeadlineExtended`: `refund_after` moved from `oldDeadline` to `newDeadline` (unix seconds). */
export interface RefundDeadlineExtendedEvent extends EscrowEventBase { type: "refundDeadlineExtended"; escrowId: bigint; oldDeadline: bigint; newDeadline: bigint }
/**
 * `Paused` / `Unpaused`: contract-wide, so `escrowId` is always `undefined`
 * (declared so `event.escrowId` stays readable on every variant); `admin`
 * flipped the flag.
 */
export interface PauseEvent extends EscrowEventBase { type: "paused" | "unpaused"; escrowId?: undefined; admin: string }

/**
 * A decoded contract event, discriminated on `type`.
 *
 * Unknown variants are retained with decoded topics so newer contract event
 * schemas remain observable to older SDK consumers instead of crashing. An
 * event whose name is known but whose payload does not have the expected
 * shape is also returned as `unknown` rather than throwing.
 *
 * New variants may be added in minor releases: a `switch` on `type` should
 * keep a `default` branch.
 */
export type EscrowEvent =
  | (EscrowEventBase & { type: EscrowLifecycleEventType; escrowId: bigint })
  | TopUpEvent
  | AcceptedEvent
  | RotatedEvent
  | PayeeTransferredEvent
  | ContributedEvent
  | ClaimedEvent
  | PayeeRefundedEvent
  | SettledEvent
  | RefundDeadlineExtendedEvent
  | PauseEvent
  | (EscrowEventBase & {
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
export interface GetEventsResult {
  events: EscrowEvent[];
  nextCursor: string;
}

/** The requested cursor predates the event history retained by the RPC server. */
export class EventCursorExpiredError extends Error {
  readonly name = "EventCursorExpiredError";
  constructor(message = "The event cursor is older than the RPC server's retention window.") {
    super(message);
  }
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
