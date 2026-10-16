import { CONTRACT_ERROR_NAMES } from "./contract-errors.generated.js";

export class EscrowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

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

export const NotFoundError = contractErrorClass("NotFound", codeFor("NotFound"));
export type NotFoundError = InstanceType<typeof NotFoundError>;
export const InvalidAmountError = contractErrorClass("InvalidAmount", codeFor("InvalidAmount"));
export type InvalidAmountError = InstanceType<typeof InvalidAmountError>;
export const UnauthorizedError = contractErrorClass("Unauthorized", codeFor("Unauthorized"));
export type UnauthorizedError = InstanceType<typeof UnauthorizedError>;
export const NotFundedError = contractErrorClass("NotFunded", codeFor("NotFunded"));
export type NotFundedError = InstanceType<typeof NotFundedError>;
export const InvalidRefundAfterError = contractErrorClass("InvalidRefundAfter", codeFor("InvalidRefundAfter"));
export type InvalidRefundAfterError = InstanceType<typeof InvalidRefundAfterError>;
export const BalanceMismatchError = contractErrorClass("BalanceMismatch", codeFor("BalanceMismatch"));
export type BalanceMismatchError = InstanceType<typeof BalanceMismatchError>;

export class SimulationFailure extends EscrowError {}
export class SubmissionFailure extends EscrowError {}
export class RequestTimeoutError extends EscrowError {}
export class NetworkMismatchError extends EscrowError {}

const knownContractErrors: Record<number, (message: string, options?: ErrorOptions) => ContractError> = {
  [codeFor("NotFound")]: (message, options) => new NotFoundError(message, options),
  [codeFor("InvalidAmount")]: (message, options) => new InvalidAmountError(message, options),
  [codeFor("Unauthorized")]: (message, options) => new UnauthorizedError(message, options),
  [codeFor("NotFunded")]: (message, options) => new NotFundedError(message, options),
  [codeFor("InvalidRefundAfter")]: (message, options) => new InvalidRefundAfterError(message, options),
  [codeFor("BalanceMismatch")]: (message, options) => new BalanceMismatchError(message, options),
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
    return new NetworkMismatchError(message, cause);
  }
  if (/simulation|simulate|tx_bad_auth|tx_insufficient_balance|diagnostic event/i.test(message)) {
    return new SimulationFailure(message, cause);
  }
  return stage === "submission" ? new SubmissionFailure(message, cause) : new SimulationFailure(message, cause);
}

export function contractErrorName(code: number): ContractErrorName | undefined {
  return (CONTRACT_ERROR_NAMES as Record<number, ContractErrorName | undefined>)[code];
}
