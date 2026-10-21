import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEscrowContext } from "./context.js";
import { isUserRejection } from "./errors.js";
import { escrowKeys } from "./queryKeys.js";
import type {
  CreateEscrowParams,
  CreateQuorumEscrowParams,
  CreateResult,
  EscrowSigner,
  TxResult,
} from "./types.js";

export type CreateEscrowActionParams = Omit<CreateEscrowParams, "payer">;
export type CreateQuorumEscrowActionParams = Omit<CreateQuorumEscrowParams, "payer">;

type EscrowAction =
  | { kind: "createEscrow"; params: CreateEscrowActionParams }
  | { kind: "createQuorumEscrow"; params: CreateQuorumEscrowActionParams }
  | { kind: "release"; escrowId: bigint }
  | { kind: "refund"; escrowId: bigint }
  | { kind: "releaseWithApprovals"; escrowId: bigint; approvers: EscrowSigner[] }
  | { kind: "refundWithApprovals"; escrowId: bigint; approvers: EscrowSigner[] };

/**
 * A user rejection is a normal outcome: it resolves, it doesn't reject.
 * Every other failure rejects (and shows up as `error` on the mutation).
 */
export type EscrowActionResult<T> =
  | { status: "success"; data: T }
  | { status: "rejected" };

/**
 * Wallet-backed actions for the escrow contract.
 *
 * The hook signs with `signer` and invalidates the matching `useEscrow` cache
 * entry after a successful settlement or creation, so a countdown/status view
 * refreshes without manual wiring. A user rejecting the wallet prompt resolves
 * as `{ status: "rejected" }`.
 *
 * ```tsx
 * const { release, isPending } = useEscrowActions(signer);
 * const result = await release(escrowId);
 * ```
 */
export function useEscrowActions(signer?: EscrowSigner) {
  const { client, clientKey } = useEscrowContext();
  const queryClient = useQueryClient();

  const requireSigner = (): EscrowSigner => {
    if (!signer) {
      throw new Error("useEscrowActions needs a signer (pass one to the hook before settling an escrow).");
    }
    return signer;
  };

  const mutation = useMutation<
    EscrowActionResult<CreateResult | TxResult>,
    Error,
    EscrowAction
  >({
    mutationFn: async (action) => {
      try {
        const activeSigner = requireSigner();
        switch (action.kind) {
          case "createEscrow":
            return { status: "success", data: await client.createEscrow({ ...action.params, payer: activeSigner }) };
          case "createQuorumEscrow":
            return { status: "success", data: await client.createQuorumEscrow({ ...action.params, payer: activeSigner }) };
          case "release":
            return { status: "success", data: await client.release({ escrowId: action.escrowId, caller: activeSigner }) };
          case "refund":
            return { status: "success", data: await client.refund({ escrowId: action.escrowId, caller: activeSigner }) };
          case "releaseWithApprovals":
            return {
              status: "success",
              data: await client.releaseWithApprovals({ escrowId: action.escrowId, approvers: action.approvers }),
            };
          case "refundWithApprovals":
            return {
              status: "success",
              data: await client.refundWithApprovals({ escrowId: action.escrowId, approvers: action.approvers }),
            };
        }
      } catch (error) {
        if (isUserRejection(error)) return { status: "rejected" };
        throw error;
      }
    },
    onSuccess: async (result, action) => {
      if (result.status !== "success") return;
      if (action.kind === "createEscrow" || action.kind === "createQuorumEscrow") {
        await queryClient.invalidateQueries({ queryKey: escrowKeys.all(clientKey) });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: escrowKeys.detail(clientKey, action.escrowId) });
    },
  });

  const createEscrow = (params: CreateEscrowActionParams) =>
    mutation.mutateAsync({ kind: "createEscrow", params }) as Promise<EscrowActionResult<CreateResult>>;

  const createQuorumEscrow = (params: CreateQuorumEscrowActionParams) =>
    mutation.mutateAsync({ kind: "createQuorumEscrow", params }) as Promise<EscrowActionResult<CreateResult>>;

  const release = (escrowId: bigint) =>
    mutation.mutateAsync({ kind: "release", escrowId }) as Promise<EscrowActionResult<TxResult>>;

  const refund = (escrowId: bigint) =>
    mutation.mutateAsync({ kind: "refund", escrowId }) as Promise<EscrowActionResult<TxResult>>;

  const releaseWithApprovals = (escrowId: bigint, approvers?: EscrowSigner[]) =>
    mutation.mutateAsync({
      kind: "releaseWithApprovals",
      escrowId,
      approvers: approvers ?? [requireSigner()],
    }) as Promise<EscrowActionResult<TxResult>>;

  const refundWithApprovals = (escrowId: bigint, approvers?: EscrowSigner[]) =>
    mutation.mutateAsync({
      kind: "refundWithApprovals",
      escrowId,
      approvers: approvers ?? [requireSigner()],
    }) as Promise<EscrowActionResult<TxResult>>;

  return {
    ...mutation,
    createEscrow,
    createQuorumEscrow,
    release,
    refund,
    releaseWithApprovals,
    refundWithApprovals,
  };
}
