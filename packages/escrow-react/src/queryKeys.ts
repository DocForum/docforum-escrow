/**
 * Stable React Query keys. Exported so integrators can prefill, invalidate or
 * persist the same cache entries the hooks use.
 *
 * `clientKey` isolates two escrow deployments (e.g. two contracts) in one
 * cache. Pass the contract id as `clientKey` to `EscrowProvider`.
 *
 * Keys for one escrow share the `detail` prefix and extend it, so
 * invalidating `detail` stays cheap and `contributions` invalidation covers
 * every contributor record of that escrow:
 *
 * - `detail`        — `useEscrow` / `useEscrowTimeline`
 * - `pooled`        — `usePooledEscrow` (escrow + funding config)
 * - `contribution`  — `useContribution` for one contributor
 * - `contributions` — every contributor record of one escrow
 */
export const escrowKeys = {
  all: (clientKey: string) => ["docforum-escrow", "escrow", clientKey] as const,
  detail: (clientKey: string, escrowId: bigint) =>
    ["docforum-escrow", "escrow", clientKey, escrowId.toString()] as const,
  pooled: (clientKey: string, escrowId: bigint) =>
    ["docforum-escrow", "escrow", clientKey, escrowId.toString(), "pooled"] as const,
  contribution: (clientKey: string, escrowId: bigint, contributor: string) =>
    ["docforum-escrow", "escrow", clientKey, escrowId.toString(), "contribution", contributor] as const,
  contributions: (clientKey: string, escrowId: bigint) =>
    ["docforum-escrow", "escrow", clientKey, escrowId.toString(), "contribution"] as const,
} as const;
