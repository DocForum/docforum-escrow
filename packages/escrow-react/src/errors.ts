import type { EscrowPreconditionErrorInfo, EscrowStatus } from "./types.js";

/**
 * True when no settlement can happen after this status — `Released`,
 * `Refunded`, or `Cancelled` (payer withdrawal before acceptance, ADR 0010).
 *
 * The set is defined here once and exhaustively: adding a member to
 * `EscrowStatus` breaks the build until it is classified as terminal or not.
 * Every hook (`useEscrow`, `useEscrowTimeline`, the pooled hooks) reads it
 * through this function, so a status can never be terminal in one place and
 * polled forever in another.
 */
export function isTerminalStatus(status: EscrowStatus | undefined | null): boolean {
  if (status === undefined || status === null) return false;
  switch (status) {
    case "Released":
    case "Refunded":
    case "Cancelled":
      return true;
    case "Funded":
      return false;
    default: {
      // Exhaustiveness guard: an unclassified status is a compile error here.
      const unhandled: never = status;
      return unhandled;
    }
  }
}

/**
 * True when a wallet rejected a request (SEP-43 code `-4`, or a matching
 * message). Rejection is a normal user decision, not a failure to report as an
 * error: `useEscrowActions` resolves it as `{ status: "rejected" }`.
 */
export function isUserRejection(error: unknown): boolean {
  if (!error) return false;
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === -4) return true;
  const name = typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : "";
  // The stellar-sdk throws `UserRejectedError` with the default `name`; the
  // message regex below is the backstop for that case.
  if (name === "UserRejected" || name === "UserRejectedError") return true;
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : "";
  return /user\s+(rejected|declined|denied|cancell?ed)|rejected\s+by\s+(the\s+)?user|request\s+(was\s+)?(rejected|declined|cancell?ed)/i.test(message);
}

/**
 * True for the SDK's `EscrowPreconditionError` — a client-side refusal
 * (wrong signer, not `Funded`, already accepted, …) raised before any
 * transaction is built. Detected structurally by `name` so the package keeps
 * its no-runtime-SDK-import guarantee.
 */
export function isEscrowPreconditionError(
  error: unknown,
): error is EscrowPreconditionErrorInfo {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    method?: unknown;
    message?: unknown;
  };
  return (
    candidate.name === "EscrowPreconditionError" &&
    typeof candidate.code === "string" &&
    typeof candidate.method === "string" &&
    typeof candidate.message === "string"
  );
}

/** Copy a precondition failure into a plain, serializable result object. */
export function preconditionFailure(
  error: EscrowPreconditionErrorInfo,
): EscrowPreconditionErrorInfo {
  return {
    name: "EscrowPreconditionError",
    code: error.code,
    method: error.method,
    message: error.message,
  };
}

/**
 * True for the SDK's `EventCursorExpiredError`: the requested cursor is older
 * than the RPC server's retention window. `useEscrowEvents` surfaces it as
 * state so an expired persisted cursor never crashes the component tree.
 */
export function isEventCursorExpiredError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { name?: unknown }).name === "EventCursorExpiredError";
}

/** Normalise an unknown thrown value into an `Error` for state. */
export function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}
