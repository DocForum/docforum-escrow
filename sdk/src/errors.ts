import { CONTRACT_ERROR_NAMES } from "./contract-errors.generated.js";
import type { EscrowStatus } from "./escrow-types.js";

/** Base class for every error the SDK throws from a contract call. */
export class EscrowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The contract returned `Error(Contract, #code)`; `code` is the contract's error number. */
export class ContractError extends EscrowError {
  readonly code: number;

  constructor(code: number, message = `Escrow contract failed with error code ${code}`, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

type ContractErrorName = (typeof CONTRACT_ERROR_NAMES)[keyof typeof CONTRACT_ERROR_NAMES];
type ContractErrorFor<Name extends ContractErrorName> = ContractError & { readonly contractError: Name };

function contractErrorClass<Name extends ContractErrorName>(name: Name, code: number) {
  const TypedContractError = class extends ContractError {
    readonly contractError = name;
    constructor(message?: string, options?: ErrorOptions) {
      super(code, message ?? `Escrow contract rejected the call: ${name}`, options);
    }
  };
  Object.defineProperty(TypedContractError, "name", { value: `${name}Error` });
  return TypedContractError;
}

function codeFor(name: ContractErrorName): number {
  const match = Object.entries(CONTRACT_ERROR_NAMES).find(([, errorName]) => errorName === name);
  if (!match) throw new Error(`Contract error ${name} is missing from the generated contract mapping`);
  return Number(match[0]);
}

/** No escrow exists with the given id (contract code 1). */
export const NotFoundError = contractErrorClass("NotFound", codeFor("NotFound"));
/** Instance type of {@link NotFoundError}. */
export type NotFoundError = InstanceType<typeof NotFoundError>;
// Named *Contract*Error: `InvalidAmountError` is already the SDK's client-side
// amount-parsing error (amounts.ts).
/** The contract rejected the amount (contract code 2). */
export const InvalidAmountContractError = contractErrorClass("InvalidAmount", codeFor("InvalidAmount"));
/** Instance type of {@link InvalidAmountContractError}. */
export type InvalidAmountContractError = InstanceType<typeof InvalidAmountContractError>;
/** The caller isn't allowed to perform this action (contract code 3). */
export const UnauthorizedError = contractErrorClass("Unauthorized", codeFor("Unauthorized"));
/** Instance type of {@link UnauthorizedError}. */
export type UnauthorizedError = InstanceType<typeof UnauthorizedError>;
/** The escrow isn't in the `Funded` state (contract code 4). */
export const NotFundedError = contractErrorClass("NotFunded", codeFor("NotFunded"));
/** Instance type of {@link NotFundedError}. */
export type NotFundedError = InstanceType<typeof NotFundedError>;
/** `refund_after` isn't in the future (contract code 5). */
export const InvalidRefundAfterError = contractErrorClass("InvalidRefundAfter", codeFor("InvalidRefundAfter"));
/** Instance type of {@link InvalidRefundAfterError}. */
export type InvalidRefundAfterError = InstanceType<typeof InvalidRefundAfterError>;
/** The token transfer didn't move the expected amount (contract code 6). */
export const BalanceMismatchError = contractErrorClass("BalanceMismatch", codeFor("BalanceMismatch"));
/** Instance type of {@link BalanceMismatchError}. */
export type BalanceMismatchError = InstanceType<typeof BalanceMismatchError>;

/** The contract is paused: creation and funding paths are blocked (contract code 38). Not transient: don't retry until it is unpaused. */
export const PausedError = contractErrorClass("Paused", codeFor("Paused"));
/** Instance type of {@link PausedError}. */
export type PausedError = InstanceType<typeof PausedError>;
/** `fund_next` ran before the schedule's `next_due` (contract code 55). */
export const ScheduleTooEarlyError = contractErrorClass("ScheduleTooEarly", codeFor("ScheduleTooEarly"));
/** Instance type of {@link ScheduleTooEarlyError}. */
export type ScheduleTooEarlyError = InstanceType<typeof ScheduleTooEarlyError>;
/** `fund_next` ran after every period was funded (contract code 56). */
export const ScheduleCompleteError = contractErrorClass("ScheduleComplete", codeFor("ScheduleComplete"));
/** Instance type of {@link ScheduleCompleteError}. */
export type ScheduleCompleteError = InstanceType<typeof ScheduleCompleteError>;
/** The schedule was cancelled: `fund_next` or a second `cancel_schedule` (contract code 57). */
export const ScheduleCancelledError = contractErrorClass("ScheduleCancelled", codeFor("ScheduleCancelled"));
/** Instance type of {@link ScheduleCancelledError}. */
export type ScheduleCancelledError = InstanceType<typeof ScheduleCancelledError>;
/** The payer's SEP-41 allowance to the escrow contract is too small or expired (contract code 58). */
export const AllowanceExhaustedError = contractErrorClass("AllowanceExhausted", codeFor("AllowanceExhausted"));
/** Instance type of {@link AllowanceExhaustedError}. */
export type AllowanceExhaustedError = InstanceType<typeof AllowanceExhaustedError>;
/** `create_schedule` got `period_seconds == 0` or `total_periods == 0` (contract code 59). */
export const InvalidScheduleError = contractErrorClass("InvalidSchedule", codeFor("InvalidSchedule"));
/** Instance type of {@link InvalidScheduleError}. */
export type InvalidScheduleError = InstanceType<typeof InvalidScheduleError>;
/** A unique creation reused a `(payer, condition_ref)` pair (issue #47, code 60). */
export const DuplicateConditionRefError = contractErrorClass("DuplicateConditionRef", codeFor("DuplicateConditionRef"));
/** Instance type of {@link DuplicateConditionRefError}. */
export type DuplicateConditionRefError = InstanceType<typeof DuplicateConditionRefError>;
/** A pooled `release_deadline` was not after `funding_deadline` (issue #288, code 61). */
export const InvalidReleaseDeadlineError = contractErrorClass("InvalidReleaseDeadline", codeFor("InvalidReleaseDeadline"));
/** Instance type of {@link InvalidReleaseDeadlineError}. */
export type InvalidReleaseDeadlineError = InstanceType<typeof InvalidReleaseDeadlineError>;

/** Simulating the transaction failed for a reason other than a contract error. */
export class SimulationFailure extends EscrowError {}
/** Submitting the signed transaction failed. */
export class SubmissionFailure extends EscrowError {}
/** The RPC request timed out. */
export class RequestTimeoutError extends EscrowError {}
/** Thrown when the RPC's reported network passphrase does not match the configured one. */
export class NetworkMismatchError extends EscrowError {
  readonly expected: string | undefined;
  readonly actual: string | undefined;
  constructor(expected?: string, actual?: string, options?: ErrorOptions & { message?: string }) {
    super(options?.message ?? `RPC network passphrase mismatch: expected "${expected}", got "${actual}".`, options);
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Thrown when a signed authorization entry has passed its expiration ledger
 * before submission (or when a rotation authorization is found to be expired
 * client-side before it is submitted).
 */
export class AuthorizationExpiredError extends EscrowError {
  readonly expirationLedger: number;
  readonly currentLedger: number;
  constructor(expirationLedger: number, currentLedger: number, options?: ErrorOptions) {
    super(
      `Authorization expired at ledger ${expirationLedger} (current ledger ${currentLedger}); re-prepare the rotation.`,
      options,
    );
    this.expirationLedger = expirationLedger;
    this.currentLedger = currentLedger;
  }
}

const knownContractErrors: Record<number, (message: string, options?: ErrorOptions) => ContractError> = {
  [codeFor("NotFound")]: (message, options) => new NotFoundError(message, options),
  [codeFor("InvalidAmount")]: (message, options) => new InvalidAmountContractError(message, options),
  [codeFor("Unauthorized")]: (message, options) => new UnauthorizedError(message, options),
  [codeFor("NotFunded")]: (message, options) => new NotFundedError(message, options),
  [codeFor("InvalidRefundAfter")]: (message, options) => new InvalidRefundAfterError(message, options),
  [codeFor("BalanceMismatch")]: (message, options) => new BalanceMismatchError(message, options),
  [codeFor("Paused")]: (message, options) => new PausedError(message, options),
  [codeFor("ScheduleTooEarly")]: (message, options) => new ScheduleTooEarlyError(message, options),
  [codeFor("ScheduleComplete")]: (message, options) => new ScheduleCompleteError(message, options),
  [codeFor("ScheduleCancelled")]: (message, options) => new ScheduleCancelledError(message, options),
  [codeFor("AllowanceExhausted")]: (message, options) => new AllowanceExhaustedError(message, options),
  [codeFor("InvalidSchedule")]: (message, options) => new InvalidScheduleError(message, options),
  [codeFor("DuplicateConditionRef")]: (message, options) => new DuplicateConditionRefError(message, options),
  [codeFor("InvalidReleaseDeadline")]: (message, options) => new InvalidReleaseDeadlineError(message, options),
};

const codePattern = /(?:Error\s*\(\s*Contract\s*,\s*#\s*(\d+)\s*\)|contract(?:\s+error)?[^\n]*?#\s*(\d+)|error\s+code\s*[:=]?\s*(\d+))/i;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function findContractCode(message: string): number | undefined {
  const match = codePattern.exec(message);
  return match ? Number(match[1] ?? match[2] ?? match[3]) : undefined;
}

/** Convert SDK/RPC exceptions into stable, catchable errors while retaining the original value as `cause`. */
export function toEscrowError(error: unknown, stage: "simulation" | "submission" = "simulation"): EscrowError {
  if (error instanceof EscrowError) return error;
  const message = errorMessage(error);
  const cause = { cause: error };
  const code = findContractCode(message);
  if (code !== undefined) {
    const factory = knownContractErrors[code];
    return factory ? factory(message, cause) : new ContractError(code, message, cause);
  }

  if (/timeout|timed out|deadline exceeded/i.test(message)) return new RequestTimeoutError(message, cause);
  if (/network.{0,20}(mismatch|passphrase)|passphrase.{0,20}(mismatch|network)/i.test(message)) {
    return new NetworkMismatchError(undefined, undefined, { message, cause: error });
  }
  if (/simulation|simulate|tx_bad_auth|tx_insufficient_balance|diagnostic event/i.test(message)) {
    return new SimulationFailure(message, cause);
  }
  return stage === "submission" ? new SubmissionFailure(message, cause) : new SimulationFailure(message, cause);
}

/**
 * Thrown by `waitForStatus` when the wait ends without reaching a target
 * status: either `timeoutMs` elapsed, or the escrow settled on a terminal
 * status outside the target set (e.g. waiting for `Released` but it was
 * `Refunded`). `lastStatus` is the last status observed, or `undefined` if
 * no read completed before the timeout.
 */
export class WaitTimeoutError extends EscrowError {
  /** The last status observed, or `undefined` if none was read before the timeout. */
  readonly lastStatus: EscrowStatus | undefined;
  /** The target statuses the caller was waiting for. */
  readonly targetStatuses: ReadonlyArray<EscrowStatus>;
  constructor(message: string, lastStatus: EscrowStatus | undefined, targetStatuses: ReadonlyArray<EscrowStatus>, options?: ErrorOptions) {
    super(message, options);
    this.name = "WaitTimeoutError";
    this.lastStatus = lastStatus;
    this.targetStatuses = targetStatuses;
  }
}

/** The contract's name for an error `code`, e.g. `NotFound` for 1, or `undefined`. */
export function contractErrorName(code: number): ContractErrorName | undefined {
  return (CONTRACT_ERROR_NAMES as Record<number, ContractErrorName | undefined>)[code];
}

/**
 * `createEscrow({ unique: true })` found an existing escrow for the same
 * `(payer, conditionRef)` whose stored terms differ from the request (issue
 * #469). Reusing a `conditionRef` with different terms is a caller bug, so
 * the SDK refuses to report it as success. `mismatched` names the differing
 * fields; `expected` and `actual` carry both sides.
 *
 * An escrow amended after creation (`topUp` grows `amount`, `transferPayee`
 * changes `payee`) also lands here on a retry: inspect `actual` to decide.
 */
export class UniqueEscrowMismatchError extends EscrowError {
  /** The existing escrow's id, recovered with `get_unique_escrow`. */
  readonly escrowId: bigint;
  /** Fields whose stored value differs from the request. */
  readonly mismatched: ReadonlyArray<"payee" | "token" | "amount">;
  /** The terms this call asked for. */
  readonly expected: Readonly<{ payee: string; token: string; amount: bigint }>;
  /** The terms stored on the existing escrow. */
  readonly actual: Readonly<{ payee: string; token: string; amount: bigint }>;

  constructor(
    escrowId: bigint,
    expected: { payee: string; token: string; amount: bigint },
    actual: { payee: string; token: string; amount: bigint },
    options?: ErrorOptions,
  ) {
    const mismatched = (["payee", "token", "amount"] as const).filter((field) => expected[field] !== actual[field]);
    super(
      `Escrow ${escrowId} already exists for this payer and conditionRef with different terms`
        + ` (${mismatched.join(", ")}); reusing a conditionRef for different terms is not idempotent.`,
      options,
    );
    this.escrowId = escrowId;
    this.mismatched = mismatched;
    this.expected = expected;
    this.actual = actual;
  }
}
