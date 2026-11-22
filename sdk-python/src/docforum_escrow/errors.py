"""Typed errors for the escrow client.

Contract failures are :class:`ContractError` subclasses, one per code in the
contract's ``Error`` enum (``contracts/escrow/src/errors.rs``), named like the
TypeScript SDK's classes (``sdk/src/errors.ts``): ``NotFoundError`` for code 1,
``UnauthorizedError`` for 3, and so on. Two names differ from ``<Name>Error``
so they never shadow something else: ``InvalidAmountContractError`` (as in the
TS SDK, where ``InvalidAmountError`` is the client-side amount error) and
``OverflowContractError`` (``OverflowError`` is a Python builtin).

A code this SDK does not know yet (a newer contract) is still raised, as a
plain :class:`ContractError` with that ``code`` and ``contract_error`` set to
``"UnknownContractError"``.

Every error the client raises derives from :class:`EscrowError`; the original
exception, when there is one, is chained as ``__cause__``.
"""

from __future__ import annotations

import re

__all__ = [
    "CONTRACT_ERROR_NAMES",
    "EscrowError",
    "ContractError",
    "InvalidArgumentError",
    "SignerRequiredError",
    "NetworkMismatchError",
    "UnsupportedAuthorizationError",
    "SimulationFailure",
    "SubmissionFailure",
    "RequestTimeoutError",
    "contract_error",
    "contract_error_name",
    "find_contract_code",
    "to_escrow_error",
    "NotFoundError",
    "InvalidAmountContractError",
    "UnauthorizedError",
    "NotFundedError",
    "InvalidRefundAfterError",
    "BalanceMismatchError",
    "ConditionRefTooLongError",
    "DisallowedTokenError",
    "CallbackFailedError",
    "OverflowContractError",
    "InvalidThresholdError",
    "TooManyReleasersError",
    "ThresholdNotMetError",
    "DuplicateApproverError",
    "DuplicateReleaserError",
    "AcceptanceRequiredError",
    "AcceptanceNotConfiguredError",
    "AlreadyAcceptedError",
    "InvalidRefundToError",
    "InvalidReleaseNotBeforeError",
    "ReleaseTooEarlyError",
    "InvalidReleaserError",
    "BatchTooLargeError",
    "NotPooledError",
    "FundingDeadlinePassedError",
    "FundingTargetReachedError",
    "FundingIncompleteError",
    "RefundNotOpenError",
    "AlreadyRefundedError",
    "NoContributionError",
    "NotSupportedForPooledError",
    "InvalidFundingDeadlineError",
    "InvalidFeeError",
    "UndeliverableError",
    "InvalidNewPayeeError",
    "PausedError",
    "AlreadyPausedError",
    "NotPausedError",
    "InvalidPayeeListError",
    "TooManyPayeesError",
    "DuplicatePayeeError",
    "InvalidBasisPointsError",
    "SplitAmountOverflowError",
    "InvalidRefundExtensionError",
    "PoolInsufficientError",
    "NotStreamedError",
    "InvalidVestingScheduleError",
    "NothingToWithdrawError",
    "StreamTopUpUnsupportedError",
    "InvalidSettlementAmountError",
    "SettlementNotSupportedError",
    "AttesterNotConfiguredError",
]

# The contract's `Error` enum. tests/test_errors.py checks this against
# contract-spec.json and contracts/escrow/src/errors.rs, so it cannot drift.
CONTRACT_ERROR_NAMES: dict[int, str] = {
    1: "NotFound",
    2: "InvalidAmount",
    3: "Unauthorized",
    4: "NotFunded",
    5: "InvalidRefundAfter",
    6: "BalanceMismatch",
    7: "ConditionRefTooLong",
    8: "DisallowedToken",
    9: "CallbackFailed",
    12: "Overflow",
    13: "InvalidThreshold",
    14: "TooManyReleasers",
    15: "ThresholdNotMet",
    16: "DuplicateApprover",
    17: "DuplicateReleaser",
    18: "AcceptanceRequired",
    19: "AcceptanceNotConfigured",
    20: "AlreadyAccepted",
    21: "InvalidRefundTo",
    22: "InvalidReleaseNotBefore",
    23: "ReleaseTooEarly",
    24: "InvalidReleaser",
    25: "BatchTooLarge",
    26: "NotPooled",
    27: "FundingDeadlinePassed",
    28: "FundingTargetReached",
    29: "FundingIncomplete",
    30: "RefundNotOpen",
    31: "AlreadyRefunded",
    32: "NoContribution",
    33: "NotSupportedForPooled",
    34: "InvalidFundingDeadline",
    35: "InvalidFee",
    36: "Undeliverable",
    37: "InvalidNewPayee",
    38: "Paused",
    39: "AlreadyPaused",
    40: "NotPaused",
    41: "InvalidPayeeList",
    42: "TooManyPayees",
    43: "DuplicatePayee",
    44: "InvalidBasisPoints",
    45: "SplitAmountOverflow",
    46: "InvalidRefundExtension",
    47: "PoolInsufficient",
    48: "NotStreamed",
    49: "InvalidVestingSchedule",
    50: "NothingToWithdraw",
    51: "StreamTopUpUnsupported",
    52: "InvalidSettlementAmount",
    53: "SettlementNotSupported",
    54: "AttesterNotConfigured",
}


class EscrowError(Exception):
    """Base class for every error the escrow client raises."""


class InvalidArgumentError(EscrowError, ValueError):
    """A caller-supplied value failed client-side validation; nothing was sent."""


class SignerRequiredError(EscrowError):
    """The call signs a transaction but the client was built without a signer."""


class NetworkMismatchError(EscrowError):
    """The client refuses this network (mainnet), or the RPC reports a different one."""

    def __init__(
        self, message: str, expected: str | None = None, actual: str | None = None
    ) -> None:
        super().__init__(message)
        self.expected = expected
        self.actual = actual


class UnsupportedAuthorizationError(EscrowError):
    """Simulation asked for an authorization the configured signer cannot give.

    For ``create_escrow`` this normally means ``notify_payee=True`` with a payee
    other than the signer: the contract would need the payee's signature too.
    """


class SimulationFailure(EscrowError):
    """Simulation failed for a reason other than a contract error."""


class SubmissionFailure(EscrowError):
    """The transaction was sent but did not succeed, with no contract code."""


class RequestTimeoutError(EscrowError):
    """The RPC request, or the wait for the transaction, timed out."""


class ContractError(EscrowError):
    """The contract returned ``Error(Contract, #code)``.

    ``code`` is the contract's error number and ``contract_error`` its name.
    Catch a specific subclass (``NotFoundError``) or this class and read
    ``code``.
    """

    code: int = 0
    contract_error: str = "UnknownContractError"

    def __init__(self, message: str | None = None, *, code: int | None = None) -> None:
        if code is not None:
            self.code = code
            self.contract_error = CONTRACT_ERROR_NAMES.get(code, "UnknownContractError")
        super().__init__(
            message
            or f"Escrow contract rejected the call: {self.contract_error} (code {self.code})"
        )


class NotFoundError(ContractError):
    """Contract error 1: ``NotFound``."""

    code = 1
    contract_error = "NotFound"


class InvalidAmountContractError(ContractError):
    """Contract error 2: ``InvalidAmount``."""

    code = 2
    contract_error = "InvalidAmount"


class UnauthorizedError(ContractError):
    """Contract error 3: ``Unauthorized``."""

    code = 3
    contract_error = "Unauthorized"


class NotFundedError(ContractError):
    """Contract error 4: ``NotFunded``."""

    code = 4
    contract_error = "NotFunded"


class InvalidRefundAfterError(ContractError):
    """Contract error 5: ``InvalidRefundAfter``."""

    code = 5
    contract_error = "InvalidRefundAfter"


class BalanceMismatchError(ContractError):
    """Contract error 6: ``BalanceMismatch``."""

    code = 6
    contract_error = "BalanceMismatch"


class ConditionRefTooLongError(ContractError):
    """Contract error 7: ``ConditionRefTooLong``."""

    code = 7
    contract_error = "ConditionRefTooLong"


class DisallowedTokenError(ContractError):
    """Contract error 8: ``DisallowedToken``."""

    code = 8
    contract_error = "DisallowedToken"


class CallbackFailedError(ContractError):
    """Contract error 9: ``CallbackFailed``."""

    code = 9
    contract_error = "CallbackFailed"


class OverflowContractError(ContractError):
    """Contract error 12: ``Overflow``."""

    code = 12
    contract_error = "Overflow"


class InvalidThresholdError(ContractError):
    """Contract error 13: ``InvalidThreshold``."""

    code = 13
    contract_error = "InvalidThreshold"


class TooManyReleasersError(ContractError):
    """Contract error 14: ``TooManyReleasers``."""

    code = 14
    contract_error = "TooManyReleasers"


class ThresholdNotMetError(ContractError):
    """Contract error 15: ``ThresholdNotMet``."""

    code = 15
    contract_error = "ThresholdNotMet"


class DuplicateApproverError(ContractError):
    """Contract error 16: ``DuplicateApprover``."""

    code = 16
    contract_error = "DuplicateApprover"


class DuplicateReleaserError(ContractError):
    """Contract error 17: ``DuplicateReleaser``."""

    code = 17
    contract_error = "DuplicateReleaser"


class AcceptanceRequiredError(ContractError):
    """Contract error 18: ``AcceptanceRequired``."""

    code = 18
    contract_error = "AcceptanceRequired"


class AcceptanceNotConfiguredError(ContractError):
    """Contract error 19: ``AcceptanceNotConfigured``."""

    code = 19
    contract_error = "AcceptanceNotConfigured"


class AlreadyAcceptedError(ContractError):
    """Contract error 20: ``AlreadyAccepted``."""

    code = 20
    contract_error = "AlreadyAccepted"


class InvalidRefundToError(ContractError):
    """Contract error 21: ``InvalidRefundTo``."""

    code = 21
    contract_error = "InvalidRefundTo"


class InvalidReleaseNotBeforeError(ContractError):
    """Contract error 22: ``InvalidReleaseNotBefore``."""

    code = 22
    contract_error = "InvalidReleaseNotBefore"


class ReleaseTooEarlyError(ContractError):
    """Contract error 23: ``ReleaseTooEarly``."""

    code = 23
    contract_error = "ReleaseTooEarly"


class InvalidReleaserError(ContractError):
    """Contract error 24: ``InvalidReleaser``."""

    code = 24
    contract_error = "InvalidReleaser"


class BatchTooLargeError(ContractError):
    """Contract error 25: ``BatchTooLarge``."""

    code = 25
    contract_error = "BatchTooLarge"


class NotPooledError(ContractError):
    """Contract error 26: ``NotPooled``."""

    code = 26
    contract_error = "NotPooled"


class FundingDeadlinePassedError(ContractError):
    """Contract error 27: ``FundingDeadlinePassed``."""

    code = 27
    contract_error = "FundingDeadlinePassed"


class FundingTargetReachedError(ContractError):
    """Contract error 28: ``FundingTargetReached``."""

    code = 28
    contract_error = "FundingTargetReached"


class FundingIncompleteError(ContractError):
    """Contract error 29: ``FundingIncomplete``."""

    code = 29
    contract_error = "FundingIncomplete"


class RefundNotOpenError(ContractError):
    """Contract error 30: ``RefundNotOpen``."""

    code = 30
    contract_error = "RefundNotOpen"


class AlreadyRefundedError(ContractError):
    """Contract error 31: ``AlreadyRefunded``."""

    code = 31
    contract_error = "AlreadyRefunded"


class NoContributionError(ContractError):
    """Contract error 32: ``NoContribution``."""

    code = 32
    contract_error = "NoContribution"


class NotSupportedForPooledError(ContractError):
    """Contract error 33: ``NotSupportedForPooled``."""

    code = 33
    contract_error = "NotSupportedForPooled"


class InvalidFundingDeadlineError(ContractError):
    """Contract error 34: ``InvalidFundingDeadline``."""

    code = 34
    contract_error = "InvalidFundingDeadline"


class InvalidFeeError(ContractError):
    """Contract error 35: ``InvalidFee``."""

    code = 35
    contract_error = "InvalidFee"


class UndeliverableError(ContractError):
    """Contract error 36: ``Undeliverable``."""

    code = 36
    contract_error = "Undeliverable"


class InvalidNewPayeeError(ContractError):
    """Contract error 37: ``InvalidNewPayee``."""

    code = 37
    contract_error = "InvalidNewPayee"


class PausedError(ContractError):
    """Contract error 38: ``Paused``."""

    code = 38
    contract_error = "Paused"


class AlreadyPausedError(ContractError):
    """Contract error 39: ``AlreadyPaused``."""

    code = 39
    contract_error = "AlreadyPaused"


class NotPausedError(ContractError):
    """Contract error 40: ``NotPaused``."""

    code = 40
    contract_error = "NotPaused"


class InvalidPayeeListError(ContractError):
    """Contract error 41: ``InvalidPayeeList``."""

    code = 41
    contract_error = "InvalidPayeeList"


class TooManyPayeesError(ContractError):
    """Contract error 42: ``TooManyPayees``."""

    code = 42
    contract_error = "TooManyPayees"


class DuplicatePayeeError(ContractError):
    """Contract error 43: ``DuplicatePayee``."""

    code = 43
    contract_error = "DuplicatePayee"


class InvalidBasisPointsError(ContractError):
    """Contract error 44: ``InvalidBasisPoints``."""

    code = 44
    contract_error = "InvalidBasisPoints"


class SplitAmountOverflowError(ContractError):
    """Contract error 45: ``SplitAmountOverflow``."""

    code = 45
    contract_error = "SplitAmountOverflow"


class InvalidRefundExtensionError(ContractError):
    """Contract error 46: ``InvalidRefundExtension``."""

    code = 46
    contract_error = "InvalidRefundExtension"


class PoolInsufficientError(ContractError):
    """Contract error 47: ``PoolInsufficient``."""

    code = 47
    contract_error = "PoolInsufficient"


class NotStreamedError(ContractError):
    """Contract error 48: ``NotStreamed``."""

    code = 48
    contract_error = "NotStreamed"


class InvalidVestingScheduleError(ContractError):
    """Contract error 49: ``InvalidVestingSchedule``."""

    code = 49
    contract_error = "InvalidVestingSchedule"


class NothingToWithdrawError(ContractError):
    """Contract error 50: ``NothingToWithdraw``."""

    code = 50
    contract_error = "NothingToWithdraw"


class StreamTopUpUnsupportedError(ContractError):
    """Contract error 51: ``StreamTopUpUnsupported``."""

    code = 51
    contract_error = "StreamTopUpUnsupported"


class InvalidSettlementAmountError(ContractError):
    """Contract error 52: ``InvalidSettlementAmount``."""

    code = 52
    contract_error = "InvalidSettlementAmount"


class SettlementNotSupportedError(ContractError):
    """Contract error 53: ``SettlementNotSupported``."""

    code = 53
    contract_error = "SettlementNotSupported"


class AttesterNotConfiguredError(ContractError):
    """Contract error 54: ``AttesterNotConfigured``."""

    code = 4200
    contract_error = "AttesterNotConfigured"


_CLASSES: dict[int, type[ContractError]] = {
    cls.code: cls for cls in ContractError.__subclasses__() if cls.code in CONTRACT_ERROR_NAMES
}


def contract_error_name(code: int) -> str | None:
    """The contract's name for ``code`` (``"NotFound"`` for 1), or ``None``."""
    return CONTRACT_ERROR_NAMES.get(code)


def contract_error(code: int, message: str | None = None) -> ContractError:
    """The typed :class:`ContractError` for ``code``; unknown codes keep their number."""
    cls = _CLASSES.get(code)
    if cls is None:
        return ContractError(message, code=code)
    return cls(message)


_CODE_PATTERN = re.compile(
    r"Error\s*\(\s*Contract\s*,\s*#\s*(\d+)\s*\)"
    r"|contract(?:\s+error)?[^\n]*?#\s*(\d+)"
    r"|error\s+code\s*[:=]?\s*(\d+)",
    re.IGNORECASE,
)


def find_contract_code(text: str) -> int | None:
    """Extract a contract error code from an RPC/host error message.

    Uses the same pattern as the TypeScript SDK's ``toEscrowError``.
    """
    match = _CODE_PATTERN.search(text)
    if not match:
        return None
    return int(next(group for group in match.groups() if group is not None))


def to_escrow_error(error: BaseException | str, stage: str = "simulation") -> EscrowError:
    """Classify an SDK/RPC failure the way the TypeScript SDK does.

    ``stage`` is ``"simulation"`` or ``"submission"`` and picks the fallback
    class when the message carries no contract code and no known category.
    """
    if isinstance(error, EscrowError):
        return error
    message = str(error)
    code = find_contract_code(message)
    if code is not None:
        result: EscrowError = contract_error(code, message)
    elif re.search(r"timeout|timed out|deadline exceeded", message, re.IGNORECASE):
        result = RequestTimeoutError(message)
    elif re.search(
        r"network.{0,20}(mismatch|passphrase)|passphrase.{0,20}(mismatch|network)",
        message,
        re.IGNORECASE,
    ):
        result = NetworkMismatchError(message)
    elif re.search(
        r"simulation|simulate|tx_bad_auth|tx_insufficient_balance|diagnostic event",
        message,
        re.IGNORECASE,
    ):
        result = SimulationFailure(message)
    elif stage == "submission":
        result = SubmissionFailure(message)
    else:
        result = SimulationFailure(message)
    if isinstance(error, BaseException):
        result.__cause__ = error
    return result
