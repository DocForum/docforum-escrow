import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useEscrowContext } from "./context.js";
import { asError, isEventCursorExpiredError } from "./errors.js";
import { escrowKeys } from "./queryKeys.js";
import type { EscrowEvent, EscrowEventType } from "./types.js";

/** Default cap on the in-memory event list. */
export const DEFAULT_MAX_EVENTS = 100;

export interface UseEscrowEventsOptions {
  /** Only events for this escrow. Omit for every escrow of the contract. */
  escrowId?: bigint;
  /** Only these lifecycle event types. Omit (or `[]`) for all of them. */
  types?: EscrowEventType[];
  /** Resume from a persisted cursor instead of the latest ledger. */
  cursor?: string;
  /** Keep at most this many recent events in memory. Default 100. */
  maxEvents?: number;
  /** Poll cadence for the subscription. Default: the provider's interval. */
  pollIntervalMs?: number;
  /** Set `false` to keep the subscription stopped. Default `true`. */
  enabled?: boolean;
  /** Called for every event after it is appended to state. */
  onEvent?: (event: EscrowEvent) => void;
}

export interface EscrowEventsState {
  /** The most recent events, oldest first, capped at `maxEvents`. */
  events: EscrowEvent[];
  /**
   * Cursor of the last event received (or the initial `cursor` until one
   * arrives). Persist it and pass it back to resume where you stopped.
   */
  cursor: string | undefined;
  /** Last polling error, if any. An expired cursor lands here as state. */
  error: Error | undefined;
  /** True when `error` is the RPC's cursor-retention failure. */
  cursorExpired: boolean;
  /** Whether a subscription is currently running. */
  subscribed: boolean;
  /** Drop the buffered events (the subscription and cursor are unchanged). */
  clear: () => void;
}

/**
 * Subscribe to the contract's lifecycle events and keep a bounded list in
 * React state.
 *
 * The hook owns the subscription lifecycle: it starts one `client.subscribe`
 * per (client, filter, cursor, interval) and stops it on unmount or when any
 * of those change — so React StrictMode's mount → unmount → mount leaves
 * exactly one live subscription. Each received event is also used to
 * invalidate the matching `useEscrow`/`usePooledEscrow` query, so a live
 * activity feed and the escrow details stay in sync.
 *
 * An expired cursor (`EventCursorExpiredError`) is surfaced as `error` /
 * `cursorExpired` state rather than thrown, so it never tears down the tree;
 * restart from a fresh `fromLedger` by clearing `cursor`.
 *
 * ```tsx
 * const { events, cursor, error } = useEscrowEvents({ escrowId, types: ["released"] });
 * localStorage.setItem("escrow-cursor", cursor ?? "");
 * ```
 */
export function useEscrowEvents(options: UseEscrowEventsOptions = {}): EscrowEventsState {
  const { client, clientKey, pollIntervalMs: providerPollIntervalMs } = useEscrowContext();
  const queryClient = useQueryClient();
  const {
    escrowId,
    types,
    cursor: initialCursor,
    maxEvents = DEFAULT_MAX_EVENTS,
    pollIntervalMs = providerPollIntervalMs,
    enabled = true,
    onEvent,
  } = options;

  const [events, setEvents] = useState<EscrowEvent[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(initialCursor);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [subscribed, setSubscribed] = useState(false);

  const maxEventsRef = useRef(maxEvents);
  maxEventsRef.current = Math.max(1, Math.floor(maxEvents));
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // Arrays are new on every render; key the effect on their content instead.
  const typesKey = types?.join(",") ?? "";

  useEffect(() => {
    if (!enabled) return;

    const subscribe = client.subscribe;
    if (!subscribe) {
      setSubscribed(false);
      setError(
        new Error(
          "useEscrowEvents needs a client that implements subscribe(); @docforum/escrow-sdk exposes it on EscrowClient.",
        ),
      );
      return;
    }

    // A new subscription starts a new buffer from the requested cursor.
    setEvents([]);
    setCursor(initialCursor);
    setError(undefined);
    setSubscribed(true);

    let active = true;
    const stop = subscribe.call(
      client,
      (event: EscrowEvent) => {
        if (!active) return;
        const limit = maxEventsRef.current;
        setEvents((previous) => {
          const next = [...previous, event];
          return next.length > limit ? next.slice(next.length - limit) : next;
        });
        setCursor(event.cursor);
        if (event.escrowId !== undefined) {
          // Both views read the same escrow; invalidate whichever is mounted.
          void queryClient.invalidateQueries({
            queryKey: escrowKeys.detail(clientKey, event.escrowId),
          });
          void queryClient.invalidateQueries({
            queryKey: escrowKeys.pooled(clientKey, event.escrowId),
          });
        }
        onEventRef.current?.(event);
      },
      {
        ...(initialCursor !== undefined ? { cursor: initialCursor } : {}),
        ...(escrowId !== undefined ? { escrowId } : {}),
        ...(typesKey.length > 0
          ? { types: typesKey.split(",") as EscrowEventType[] }
          : {}),
        pollIntervalMs,
        // Never let subscribe rethrow into a microtask: errors are state.
        onError: (pollError) => {
          if (!active) return;
          setError(asError(pollError));
        },
      },
    );

    return () => {
      active = false;
      stop();
      setSubscribed(false);
    };
  }, [
    client,
    clientKey,
    escrowId,
    typesKey,
    initialCursor,
    pollIntervalMs,
    enabled,
    queryClient,
  ]);

  const clear = useCallback(() => setEvents([]), []);

  return {
    events,
    cursor,
    error,
    cursorExpired: error !== undefined && isEventCursorExpiredError(error),
    subscribed,
    clear,
  };
}
