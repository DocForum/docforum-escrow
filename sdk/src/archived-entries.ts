/**
 * What a call should do when the contract state it needs has been archived:
 * `"auto"` attempts an on-chain restore (the signer pays the fee), `"error"`
 * throws {@link ArchivedEntryError} instead.
 */
export type ArchivedEntryBehavior = "auto" | "error";

/** Typed error for contract calls that cannot restore archived ledger entries. */
export class ArchivedEntryError extends Error {
  readonly method: string;
  override readonly cause?: unknown;
  constructor(method: string, behavior: ArchivedEntryBehavior, cause?: unknown) {
    super(behavior === "auto"
      ? `Contract state needed by ${method} is archived and automatic restoration failed. Ensure the configured signer can pay the restoration fee.`
      : `Contract state needed by ${method} is archived. Set archivalBehavior to "auto" and provide a restore signer to restore it.`);
    this.name = "ArchivedEntryError";
    this.method = method;
    this.cause = cause;
  }
}

/** True when `error` is a contract failure caused by archived/expired ledger state. */
export function isArchivedEntryFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; message?: unknown };
  return candidate.name === "ExpiredState" ||
    (typeof candidate.message === "string" && /expired state|archived (?:contract )?state|automatic restoration attempt limit reached/i.test(candidate.message));
}
