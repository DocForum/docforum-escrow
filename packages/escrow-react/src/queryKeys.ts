/**
 * Stable React Query keys. Exported so integrators can prefill, invalidate or
 * persist the same cache entries the hooks use.
 *
 * `clientKey` isolates two escrow deployments (e.g. two contracts) in one
 * cache. Pass the contract id as `clientKey` to `EscrowProvider`.
 */
export const escrowKeys = {
  all: (clientKey: string) => ["docforum-escrow", "escrow", clientKey] as const,
  detail: (clientKey: string, escrowId: bigint) =>
    ["docforum-escrow", "escrow", clientKey, escrowId.toString()] as const,
} as const;
