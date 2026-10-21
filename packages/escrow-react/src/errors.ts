import type { EscrowStatus } from "./types.js";

/** `Released` and `Refunded` are final: no settlement can happen afterwards. */
export function isTerminalStatus(status: EscrowStatus | undefined | null): boolean {
  return status === "Released" || status === "Refunded";
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
