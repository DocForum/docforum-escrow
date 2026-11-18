import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useEscrowContext } from "./context.js";
import { isTerminalStatus } from "./errors.js";
import { escrowKeys } from "./queryKeys.js";
import type { Escrow } from "./types.js";

export interface UseEscrowOptions {
  /** Set `false` to hold the query until the id is known. Default `true`. */
  enabled?: boolean;
  /** Override the provider's poll interval. `0` disables polling. */
  pollIntervalMs?: number;
  /** How long a fetched escrow is considered fresh. Default: React Query's. */
  staleTimeMs?: number;
  /** Default: React Query's (`true`). */
  refetchOnWindowFocus?: boolean;
}

/**
 * Fetch one escrow and keep it fresh until it settles.
 *
 * Polling stops automatically once the status is `Released` or `Refunded`
 * (terminal), and never runs at all for a call that already returned a
 * terminal status. Transient read errors keep polling as long as data is not
 * terminal, so a dropped RPC connection doesn't freeze the UI.
 */
export function useEscrow(
  escrowId: bigint,
  options: UseEscrowOptions = {},
): UseQueryResult<Escrow, Error> {
  const { client, clientKey, pollIntervalMs } = useEscrowContext();
  const interval = options.pollIntervalMs ?? pollIntervalMs;

  return useQuery({
    queryKey: escrowKeys.detail(clientKey, escrowId),
    queryFn: () => client.getEscrow(escrowId),
    enabled: options.enabled ?? true,
    ...(options.staleTimeMs !== undefined ? { staleTime: options.staleTimeMs } : {}),
    ...(options.refetchOnWindowFocus !== undefined
      ? { refetchOnWindowFocus: options.refetchOnWindowFocus }
      : {}),
    // React Query v5: returning `false` stops future refetches for this query.
    refetchInterval: (query) => {
      if (isTerminalStatus(query.state.data?.status)) return false;
      return interval > 0 ? interval : false;
    },
  });
}
