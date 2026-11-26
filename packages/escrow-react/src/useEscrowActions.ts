import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEscrowContext } from "./context.js";
import { isEscrowPreconditionError, isUserRejection, preconditionFailure } from "./errors.js";
import { escrowKeys } from "./queryKeys.js";
import type {
  CreateEscrowParams,
  CreateQuorumEscrowParams,
  CreateResult,
  EscrowPreconditionErrorInfo,
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
  | { kind: "refundWithApprovals"; escrowId: bigint; approvers: EscrowSigner[] }
  | { kind: "accept"; escrowId: bigint }
  | { kind: "cancel"; escrowId: bigint }
  | { kind: "topUp"; escrowId: bigint; amount: bigint }
  | { kind: "contribute"; escrowId: bigint; amount: bigint }
  | { kind: "claimRefund"; escrowId: bigint };

/**
 * A user rejection is a normal outcome: it resolves, it doesn't reject.
 * Every other failure rejects (and shows up as `error` on the mutation),
 * except a client-side `EscrowPreconditionError`, which resolves as a typed
 * `{ status: "precondition" }` failure so callers can branch on its `code`
 * (for example `AlreadyAccepted`) without catching exceptions.
 */
export type EscrowActionResult<T> =
  | { status: "success"; data: T }
  | { status: "rejected" }
  | { status: "precondition"; error: EscrowPreconditionErrorInfo };

/**
 * Wallet-backed actions for the escrow contract.
 *
 * The hook signs with `signer` and invalidates the matching query after a
 * successful call, so a countdown/status view refreshes without manual
 * wiring. A user rejecting the wallet prompt resolves as
 * `{ status: "rejected" }`, and a client-side precondition refusal resolves
 * as `{ status: "precondition" }`.
 *
 * ```tsx
 * const { release, accept, cancel, topUp, contribute, claimRefund } = useEscrowActions(signer);
 * const result = await accept(escrowId);
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
          case "accept":
            return {
              status: "success",
              data: await client.accept({ escrowId: action.escrowId, payee: activeSigner }),
            };
          case "cancel":
            return {
              status: "success",
              data: await client.cancel({ escrowId: action.escrowId, payer: activeSigner }),
            };
          case "topUp":
            return {
              status: "success",
              data: await client.topUp({
                escrowId: action.escrowId,
                payer: activeSigner,
                amount: action.amount,
              }),
            };
          case "contribute":
            return {
              status: "success",
              data: await client.contribute({
                escrowId: action.escrowId,
                payer: activeSigner,
                amount: action.amount,
              }),
            };
          case "claimRefund":
            return {
              status: "success",
              data: await client.claimRefund({
                escrowId: action.escrowId,
                contributor: activeSigner,
              }),
            };
        }
      } catch (error) {
        if (isUserRejection(error)) return { status: "rejected" };
        if (isEscrowPreconditionError(error)) {
          return { status: "precondition", error: preconditionFailure(error) };
        }
        throw error;
      }
    },
    onSuccess: async (result, action) => {
      if (result.status !== "success") return;
      if (action.kind === "createEscrow" || action.kind === "createQuorumEscrow") {
        await queryClient.invalidateQueries({ queryKey: escrowKeys.all(clientKey) });
        return;
      }
      // Every per-escrow key (`pooled`, `contribution(s)`) nests under
      // `detail`, and React Query invalidates by key prefix — so this one
      // call refreshes the settlement view and both pooled queries after a
      // contribute/claim as well.
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

  const accept = (escrowId: bigint) =>
    mutation.mutateAsync({ kind: "accept", escrowId }) as Promise<EscrowActionResult<TxResult>>;

  const cancel = (escrowId: bigint) =>
    mutation.mutateAsync({ kind: "cancel", escrowId }) as Promise<EscrowActionResult<TxResult>>;

  const topUp = (escrowId: bigint, amount: bigint) =>
    mutation.mutateAsync({ kind: "topUp", escrowId, amount }) as Promise<EscrowActionResult<TxResult>>;

  const contribute = (escrowId: bigint, amount: bigint) =>
    mutation.mutateAsync({ kind: "contribute", escrowId, amount }) as Promise<EscrowActionResult<TxResult>>;

  const claimRefund = (escrowId: bigint) =>
    mutation.mutateAsync({ kind: "claimRefund", escrowId }) as Promise<EscrowActionResult<TxResult>>;

  return {
    ...mutation,
    createEscrow,
    createQuorumEscrow,
    release,
    refund,
    releaseWithApprovals,
    refundWithApprovals,
    accept,
    cancel,
    topUp,
    contribute,
    claimRefund,
  };
}
