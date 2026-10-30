"""Typed errors matching the contract's ``Error`` enum (mirrors the TS SDK).

The contract defines these codes in ``contracts/escrow/src/lib.rs``. This module
mirrors them so Python integrators get the same typed failure surface as the
TypeScript SDK -- never a stringly-matched exception message.
"""

from __future__ import annotations

import re
from enum import IntEnum
from typing import Dict, Optional


class EscrowErrorCode(IntEnum):
    """Integer codes from the contract's ``Error`` enum.

    Keep in sync with ``contracts/escrow/src/lib.rs`` (and the TS SDK's error
    map): a contract-side change is a SDK semver event.
    """

    NOT_FOUND = 1
    INVALID_AMOUNT = 2
    UNAUTHORIZED = 3
    NOT_FUNDED = 4
    INVALID_REFUND_AFTER = 5
    BALANCE_MISMATCH = 6
    CONDITION_REF_TOO_LONG = 7
    DISALLOWED_TOKEN = 8
    CALLBACK_FAILED = 9
    OVERFLOW = 12
    INVALID_THRESHOLD = 13
    TOO_MANY_RELEASERS = 14
    THRESHOLD_NOT_MET = 15
    DUPLICATE_APPROVER = 16
    DUPLICATE_RELEASER = 17
    ACCEPTANCE_REQUIRED = 18
    ACCEPTANCE_NOT_CONFIGURED = 19
    ALREADY_ACCEPTED = 20
    INVALID_REFUND_TO = 21
    INVALID_RELEASE_NOT_BEFORE = 22
    RELEASE_TOO_EARLY = 23
    INVALID_RELEASER = 24


ERROR_MESSAGES: Dict[int, str] = {
    EscrowErrorCode.NOT_FOUND: "NotFound",
    EscrowErrorCode.INVALID_AMOUNT: "InvalidAmount",
    EscrowErrorCode.UNAUTHORIZED: "Unauthorized",
    EscrowErrorCode.NOT_FUNDED: "NotFunded",
    EscrowErrorCode.INVALID_REFUND_AFTER: "InvalidRefundAfter",
    EscrowErrorCode.BALANCE_MISMATCH: "BalanceMismatch",
    EscrowErrorCode.CONDITION_REF_TOO_LONG: "ConditionRefTooLong",
    EscrowErrorCode.DISALLOWED_TOKEN: "DisallowedToken",
    EscrowErrorCode.CALLBACK_FAILED: "CallbackFailed",
    EscrowErrorCode.OVERFLOW: "Overflow",
    EscrowErrorCode.INVALID_THRESHOLD: "InvalidThreshold",
    EscrowErrorCode.TOO_MANY_RELEASERS: "TooManyReleasers",
    EscrowErrorCode.THRESHOLD_NOT_MET: "ThresholdNotMet",
    EscrowErrorCode.DUPLICATE_APPROVER: "DuplicateApprover",
    EscrowErrorCode.DUPLICATE_RELEASER: "DuplicateReleaser",
    EscrowErrorCode.ACCEPTANCE_REQUIRED: "AcceptanceRequired",
    EscrowErrorCode.ACCEPTANCE_NOT_CONFIGURED: "AcceptanceNotConfigured",
    EscrowErrorCode.ALREADY_ACCEPTED: "AlreadyAccepted",
    EscrowErrorCode.INVALID_REFUND_TO: "InvalidRefundTo",
    EscrowErrorCode.INVALID_RELEASE_NOT_BEFORE: "InvalidReleaseNotBefore",
    EscrowErrorCode.RELEASE_TOO_EARLY: "ReleaseTooEarly",
    EscrowErrorCode.INVALID_RELEASER: "InvalidReleaser",
}

# The host renders contract errors as e.g. "HostError: Error(Contract, #1)".
_CONTRACT_ERROR_PATTERN = re.compile(r"Error\(Contract,\s*#(\d+)\)")


class EscrowError(Exception):
    """A typed error raised when the contract returns an ``Error``.

    Carries the numeric ``code`` and the contract's symbol ``name`` (e.g.
    ``EscrowError(code=1, name='NotFound')``) so callers can branch on either
    without parsing a message.
    """

    def __init__(
        self,
        code: int,
        name: Optional[str] = None,
        detail: Optional[str] = None,
    ) -> None:
        self.code = int(code)
        self.name = name or ERROR_MESSAGES.get(self.code, f"UnknownError({self.code})")
        self.detail = detail
        message = f"{self.name} (code {self.code})"
        if detail:
            message += f": {detail}"
        super().__init__(message)

    def __repr__(self) -> str:
        return f"EscrowError(code={self.code}, name={self.name!r})"


def error_from_code(code: int, detail: Optional[str] = None) -> EscrowError:
    """Build an ``EscrowError`` from a contract error code."""
    return EscrowError(code=code, name=ERROR_MESSAGES.get(int(code)), detail=detail)


def error_from_message(message: str) -> Optional[EscrowError]:
    """Extract a contract ``Error`` from a host error string, if there is one."""
    match = _CONTRACT_ERROR_PATTERN.search(message or "")
    if not match:
        return None
    return error_from_code(int(match.group(1)), detail=message)


__all__ = [
    "EscrowError",
    "EscrowErrorCode",
    "ERROR_MESSAGES",
    "error_from_code",
    "error_from_message",
]
