import { describe, expect, it } from "vitest";
import { CONTRACT_ERROR_NAMES } from "../src/contract-errors.generated.js";
import {
  BalanceMismatchError,
  ContractError,
  InvalidAmountError,
  InvalidRefundAfterError,
  NetworkMismatchError,
  NotFoundError,
  NotFundedError,
  RequestTimeoutError,
  SimulationFailure,
  SubmissionFailure,
  UnauthorizedError,
  toEscrowError,
} from "../src/errors.js";

const expectedErrors = [
  [1, NotFoundError, "NotFound"],
  [2, InvalidAmountError, "InvalidAmount"],
  [3, UnauthorizedError, "Unauthorized"],
  [4, NotFundedError, "NotFunded"],
  [5, InvalidRefundAfterError, "InvalidRefundAfter"],
  [6, BalanceMismatchError, "BalanceMismatch"],
] as const;

describe("SDK errors", () => {
  it("maps each contract enum code to its typed error and preserves the cause", () => {
    for (const [code, ErrorClass, contractError] of expectedErrors) {
      expect(CONTRACT_ERROR_NAMES[code]).toBe(contractError);
      const cause = new Error(`Error(Contract, #${code})`);
      const mapped = toEscrowError(cause);
      expect(mapped).toBeInstanceOf(ErrorClass);
      expect(mapped).toMatchObject({ code, contractError, cause });
    }
  });

  it("maps unknown future contract codes to generic ContractError", () => {
    const cause = new Error("Error(Contract, #97)");
    const mapped = toEscrowError(cause);
    expect(mapped).toBeInstanceOf(ContractError);
    expect(mapped).not.toBeInstanceOf(NotFoundError);
    expect(mapped).toMatchObject({ code: 97, cause });
  });

  it("classifies RPC simulation, submission, timeout, and network mismatch failures", () => {
    expect(toEscrowError(new Error("simulation failed: tx_bad_auth"))).toBeInstanceOf(SimulationFailure);
    expect(toEscrowError(new Error("server unavailable"), "submission")).toBeInstanceOf(SubmissionFailure);
    expect(toEscrowError(new Error("request timed out"))).toBeInstanceOf(RequestTimeoutError);
    expect(toEscrowError(new Error("network passphrase mismatch"))).toBeInstanceOf(NetworkMismatchError);
  });
});
