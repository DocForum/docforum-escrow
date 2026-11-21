"""Value types returned by the escrow client."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

__all__ = ["CreateEscrowResult", "Escrow", "EscrowStatus", "PayeeShare", "TxResult"]


class EscrowStatus(str, Enum):
    """The contract's ``EscrowStatus``. ``Funded`` is the only non-terminal state."""

    FUNDED = "Funded"
    RELEASED = "Released"
    REFUNDED = "Refunded"
    CANCELLED = "Cancelled"

    @property
    def is_terminal(self) -> bool:
        return self is not EscrowStatus.FUNDED


@dataclass(frozen=True)
class PayeeShare:
    """One direct release recipient and its share in basis points (10 000 = 100 %)."""

    payee: str
    basis_points: int


@dataclass(frozen=True)
class Escrow:
    """The contract's ``EscrowData`` record, as returned by ``get_escrow``.

    ``amount`` is a Python ``int`` because the contract stores an ``i128``;
    never convert it to ``float``. Addresses are strkeys (``G...`` or
    ``C...``). Fields a deployment does not have yet are ``None``; fields
    this SDK does not know are kept, decoded, in ``extra``.
    """

    payer: str
    payee: str
    token: str
    amount: int
    condition_ref: str
    status: EscrowStatus
    releasers: tuple[str, ...]
    threshold: int
    refund_after: int | None = None
    notify_payee: bool = False
    payees: tuple[PayeeShare, ...] = ()
    requires_acceptance: bool | None = None
    accepted_at: int | None = None
    refund_to: str | None = None
    release_not_before: int | None = None
    fee_recipient: str | None = None
    fee_bps: int | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class TxResult:
    """A confirmed state-changing transaction."""

    tx_hash: str
    ledger: int | None = None


@dataclass(frozen=True)
class CreateEscrowResult:
    """A confirmed ``create_escrow``: the new escrow's id and its transaction."""

    escrow_id: int
    tx_hash: str
    ledger: int | None = None
