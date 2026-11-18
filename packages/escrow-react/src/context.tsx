import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { EscrowClientLike } from "./types.js";

/** Default polling cadence for a non-terminal escrow: 5 seconds. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface EscrowClientContextValue {
  client: EscrowClientLike;
  /** Cache namespace; pass the contract id when running more than one. */
  clientKey: string;
  /** Poll interval for `useEscrow`; `0` disables polling. */
  pollIntervalMs: number;
}

const EscrowClientContext = createContext<EscrowClientContextValue | undefined>(undefined);

export interface EscrowProviderProps {
  /** An `EscrowClient` (or any object with the same methods). */
  client: EscrowClientLike;
  /** Cache namespace, e.g. the contract id. Default `"default"`. */
  clientKey?: string;
  /** Default: {@link DEFAULT_POLL_INTERVAL_MS}. `0` disables polling. */
  pollIntervalMs?: number;
  children?: ReactNode;
}

/**
 * Supplies the escrow client to the hooks. This is **not** a UI component and
 * renders no DOM. It must sit inside your existing `QueryClientProvider`.
 */
export function EscrowProvider({
  client,
  clientKey = "default",
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  children,
}: EscrowProviderProps) {
  const value = useMemo(
    () => ({ client, clientKey, pollIntervalMs }),
    [client, clientKey, pollIntervalMs],
  );
  return <EscrowClientContext.Provider value={value}>{children}</EscrowClientContext.Provider>;
}

export function useEscrowContext(): EscrowClientContextValue {
  const value = useContext(EscrowClientContext);
  if (!value) {
    throw new Error("useEscrow hooks must be used inside <EscrowProvider client={...}>.");
  }
  return value;
}
