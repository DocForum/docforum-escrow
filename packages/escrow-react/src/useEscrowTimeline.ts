import { useEffect, useRef, useState } from "react";
import { isTerminalStatus } from "./errors.js";
import type { Escrow, EscrowStatus } from "./types.js";

export interface UseEscrowTimelineOptions {
  /** Clock source, for tests or a monotonic clock. Default `Date.now`. */
  now?: () => number;
  /** Countdown tick. Default 1000 ms. `0` freezes the countdown. */
  intervalMs?: number;
  /**
   * `ledgerNow - localNow`, in milliseconds. Default `0`.
   *
   * `refundAfter` is a **ledger timestamp** in unix seconds (the contract
   * compares it to the ledger close time, not your machine's clock). A local
   * countdown is therefore advisory: derive this offset from
   * `getLatestLedger().closeTime * 1000 - Date.now()` so client clock drift
   * does not show a deadline as passed when the contract still rejects the
   * timeout refund, or vice versa.
   */
  ledgerTimeOffsetMs?: number;
}

export interface EscrowTimeline {
  /** The contract's deadline, in unix seconds; `undefined` means no timeout. */
  refundAfter?: bigint;
  /** Estimated ledger time (local clock + offset), in ms. */
  ledgerNowMs: number;
  /** Milliseconds until `refundAfter`, floored at 0; `undefined` without a deadline. */
  remainingMs?: number;
  /** True once the estimated ledger time reaches `refundAfter`. */
  expired: boolean;
  /** The escrow's stored status, if known. */
  status?: EscrowStatus;
  /** `Released`/`Refunded` — the countdown no longer matters. */
  isTerminal: boolean;
  /** Whether the escrow has a deadline at all. */
  hasDeadline: boolean;
}

/**
 * Countdown to an escrow's `refundAfter` deadline, derived from a fetched
 * escrow. It renders nothing and fetches nothing: pass the result of
 * `useEscrow(id)` and the hook re-renders once per tick until the deadline or
 * a terminal status is reached.
 *
 * ```tsx
 * const { data } = useEscrow(id);
 * const { remainingMs, expired } = useEscrowTimeline(data);
 * ```
 */
export function useEscrowTimeline(
  escrow: Escrow | undefined | null,
  options: UseEscrowTimelineOptions = {},
): EscrowTimeline {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 1_000;
  const offsetMs = options.ledgerTimeOffsetMs ?? 0;
  const nowRef = useRef(now);
  nowRef.current = now;

  const [nowMs, setNowMs] = useState(() => nowRef.current());
  const status = escrow?.status;
  const isTerminal = isTerminalStatus(status);
  const refundAfter = escrow?.refundAfter;
  const refundAfterMs = refundAfter === undefined ? undefined : Number(refundAfter) * 1_000;
  const ledgerNowMs = nowMs + offsetMs;
  const remainingMs = refundAfterMs === undefined ? undefined : Math.max(0, refundAfterMs - ledgerNowMs);
  const expired = refundAfterMs !== undefined && ledgerNowMs >= refundAfterMs;

  useEffect(() => {
    // Settled escrows and passed deadlines do not need a timer; this is what
    // stops the countdown (and its re-renders) at the right moment.
    if (refundAfterMs === undefined || isTerminal || expired || intervalMs <= 0) return;
    const timer = setInterval(() => setNowMs(nowRef.current()), intervalMs);
    return () => clearInterval(timer);
  }, [refundAfterMs, isTerminal, expired, intervalMs]);

  return {
    refundAfter,
    ledgerNowMs,
    remainingMs,
    expired,
    status,
    isTerminal,
    hasDeadline: refundAfterMs !== undefined,
  };
}
