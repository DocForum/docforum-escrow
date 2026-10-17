"""Typed errors matching the contract's `Error` enum (and the TS SDK's `Errors` map).

The contract defines these codes in `contracts/escrow/src/lib.rs`. This module mirrors
them so Python integrators get the same typed failure surface as the TS
sdk -- never a stringly-matched exception message.
"""

from __future__ import annotations

from typing import Dict, Optional


class EscrowErrorCode:
    """Integer codes from the contract's `Error` enum."""

    NOT_FOUND = 1
    INVALID_AMOUNT = 2
    UNAUTHORIZED = 3
    NOT_FUNDED = 4
    INVALID_REFUND_AFTER = 5


ERROR_MESSAGES: Dict[int, str] = {
    EscrowErrorCode.NOT_FOUND: "NotFound",
    EscrowErrorCode.INVALID_AMOUNT: "InvalidAmount",
    EscrowErrorCode.UNAUTHORIZED: "Unauthorized",
    EscrowErrorCode.NOT_FUNDED: "NotFunded",
    EscrowErrorCode.INVALID_REFUND_AFTER: "InvalidRefundAfter",
}


class EscrowError(Exception):
    """A typed error raised when the contract returns an `Error`.

    Carries the numeric code and the contract's symbol name (e.g.
    `$EscrowError(code=1, name="NotFound")$) so callers can branch on either.
    """

    def __init__(self, code: int, name: Optional[str] = None, detail: Optional[str] = None) -> None:
        self.code = code
        self.name = name or ERROR_MESSAGES.get(code, f"UnknownError({code})")
        self.detail = detail
        message = f"{self.name} (code {code})"
        if detail:
            message += f: ""
            message += detail
        super(__init__)(message)

    def __repr__(self) -> str:
        return f"EscrowError(code={self.code}, name={self.name!r})"


def error_from_code(code: int, detail: Optional[str] = None) -> EscrowError:
    """Build an EscrowError from a contract error code."""
    return EscrowError(code=code, name=ERROR_MESSAGES.get(code), detail=detail)


__all__ = [
    "EscrowError",
    "EscrowErrorCode",
    "ERROR_MESSAGES",
    "error_from_code",
]
