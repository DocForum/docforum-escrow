import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useEscrowContext } from "./context.js";
import { isTerminalStatus } from "./errors.js";
import { escrowKeys } from "./queryKeys.js";
import type {
  ContributionRecord,
  Escrow,
  PooledEscrow,
  PooledEscrowPhase,
} from "./types.js";

/** One pooled escrow read: the settlement record plus its funding config. */
export interface PooledEscrowSnapshot {
  escrow: Escrow;
  pooled: PooledEscrow;
}

export interface UsePooledEscrowOptions {
  /** Set `false` to hold the query until the id is known. Default `true`. */
  enabled?: boolean;
  /** Override the provider's poll interval. `0` disables polling. */
  pollIntervalMs?: number;
  /** How long a fetched snapshot is considered fresh. Default: React Query's. */
  staleTimeMs?: number;
  /**
   * Current **ledger** time in unix seconds, for classifying the phase
   * against `fundingDeadline`. Default `Math.floor(Date.now() / 1000)`.
   *
   * `funding_deadline` is a ledger timestamp, so the local clock is advisory:
   * pass the latest ledger close time for a phase that can never disagree with
   * the contract by more than clock drift.
   */
  now?: () => number;
}

export type UsePooledEscrowResult = UseQueryResult<PooledEscrowSnapshot, Error> & {
  /** The escrow's stored record (`getEscrow`) once loaded. */
  escrow: Escrow | undefined;
  /** The immutable funding target and deadline (`getPooled`) once loaded. */
  pooled: PooledEscrow | undefined;
  /** Derived funding phase; `undefined` until the first read completes. */
  phase: PooledEscrowPhase | undefined;
  /**
   * True for `released` and `failed` — the two phases where nothing the UI
   * polls can change any more, so polling stops.
   */
  isSettled: boolean;
};

/**
 * Derive a pooled escrow's funding phase from the contract's boundary rules.
 *
 * The contract treats a failed round as still `Funded` (status describes
 * settlement, not funding), so status alone cannot drive polling:
 *
 * - `Released` is a successful payout → `released`.
 * - A round that closed as `Refunded`/`Cancelled` is over → `failed`.
 * - `amount >= fundingTarget` → `funded` (overfunding is rejected, and the
 *   deadline no longer matters once the target is reached).
 * - Otherwise the round is `failed` once the deadline passes, and `open`
 *   before it.
 *
 * `nowSeconds` should be ledger time; compare in whole seconds, like the
 * contract does.
 */
export function pooledEscrowPhase(
  escrow: Pick<Escrow, "status" | "amount">,
  pooled: Pick<PooledEscrow, "fundingTarget" | "fundingDeadline">,
  nowSeconds: number,
): PooledEscrowPhase {
  if (escrow.status === "Released") return "released";
  if (!isTerminalStatus(escrow.status)) {
    if (escrow.amount >= pooled.fundingTarget) return "funded";
    if (BigInt(Math.floor(nowSeconds)) < pooled.fundingDeadline) return "open";
  }
  return "failed";
}

const defaultNow = () => Math.floor(Date.now() / 1000);

/**
 * Fetch a pooled escrow (settlement record + funding config) and poll it
 * until the funding phase is settled.
 *
 * Polling is **phase-aware**, not status-aware: a failed round stays
 * `Funded` on-chain forever, so a status-only rule would poll it for as long
 * as the component is mounted. Here it stops as soon as the phase is
 * `failed` or `released`. Pass `pollIntervalMs={0}` to disable polling.
 *
 * ```tsx
 * const { phase, escrow, pooled, isSettled } = usePooledEscrow(escrowId);
 * // open | funded | failed | released
 * ```
 */
export function usePooledEscrow(
  escrowId: bigint,
  options: UsePooledEscrowOptions = {},
): UsePooledEscrowResult {
  const { client, clientKey, pollIntervalMs } = useEscrowContext();
  const interval = options.pollIntervalMs ?? pollIntervalMs;
  const now = options.now ?? defaultNow;

  const query = useQuery({
    queryKey: escrowKeys.pooled(clientKey, escrowId),
    queryFn: async (): Promise<PooledEscrowSnapshot> => {
      const [escrow, pooled] = await Promise.all([
        client.getEscrow(escrowId),
        client.getPooled(escrowId),
      ]);
      return { escrow, pooled };
    },
    enabled: options.enabled ?? true,
    ...(options.staleTimeMs !== undefined ? { staleTime: options.staleTimeMs } : {}),
    refetchInterval: (q) => {
      const data = q.state.data;
      // No data yet, or a non-terminal phase: keep polling while enabled.
      if (data) {
        const phase = pooledEscrowPhase(data.escrow, data.pooled, now());
        if (phase === "released" || phase === "failed") return false;
      }
      return interval > 0 ? interval : false;
    },
  });

  const data = query.data;
  const phase = data ? pooledEscrowPhase(data.escrow, data.pooled, now()) : undefined;
  return {
    ...query,
    escrow: data?.escrow,
    pooled: data?.pooled,
    phase,
    isSettled: phase === "released" || phase === "failed",
  };
}

export interface UseContributionOptions {
  /**
   * Set `false` to hold the query. It is also held automatically while the
   * contributor address is empty/unknown.
   */
  enabled?: boolean;
  /** How long a fetched record is considered fresh. Default: React Query's. */
  staleTimeMs?: number;
}

/**
 * Read one contributor's record on a pooled escrow (`getContribution`):
 * their accepted total and whether they already claimed a failed round.
 *
 * `undefined` data means the address never contributed. The query does not
 * poll; `useEscrowActions(signer).contribute` / `claimRefund` invalidate it
 * after a successful call.
 */
export function useContribution(
  escrowId: bigint,
  contributor: string | undefined | null,
  options: UseContributionOptions = {},
): UseQueryResult<ContributionRecord | undefined, Error> {
  const { client, clientKey } = useEscrowContext();
  const address = contributor ?? "";
  return useQuery({
    queryKey: escrowKeys.contribution(clientKey, escrowId, address),
    queryFn: () => client.getContribution(escrowId, address),
    enabled: (options.enabled ?? true) && address.length > 0,
    ...(options.staleTimeMs !== undefined ? { staleTime: options.staleTimeMs } : {}),
  });
}
