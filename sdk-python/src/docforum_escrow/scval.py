"""Conversions between Python values and the contract's Soroban ``SCVal`` types.

Encoders validate before anything is sent, so a bad argument raises
:class:`~docforum_escrow.errors.InvalidArgumentError` instead of costing a
simulation round trip. Decoders turn ``get_escrow`` / ``get_status`` return
values into :mod:`docforum_escrow.types` objects.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar

from stellar_sdk import Address, scval, xdr

from .errors import InvalidArgumentError
from .types import Escrow, EscrowStatus, PayeeShare

T = TypeVar("T")

I128_MIN = -(2**127)
I128_MAX = 2**127 - 1
U64_MAX = 2**64 - 1
U32_MAX = 2**32 - 1
#: ``MAX_CONDITION_REF_LEN`` in ``contracts/escrow/src/constants.rs`` (bytes).
MAX_CONDITION_REF_LEN = 64


def _require_int(name: str, value: Any) -> int:
    # bool is an int subclass; True as an amount is always a bug.
    if isinstance(value, bool) or not isinstance(value, int):
        raise InvalidArgumentError(f"{name} must be an int, got {type(value).__name__}")
    return value


def address(name: str, value: Any) -> xdr.SCVal:
    """An account (``G...``) or contract (``C...``) strkey as an ``Address``."""
    if not isinstance(value, str):
        raise InvalidArgumentError(f"{name} must be a strkey string")
    try:
        return scval.to_address(Address(value))
    except Exception as exc:  # stellar_sdk raises ValueError and its own types
        raise InvalidArgumentError(f"{name} is not a valid Stellar address: {value!r}") from exc


def i128(name: str, value: Any) -> xdr.SCVal:
    """An ``i128``. Python ints are unbounded, so the range is checked here."""
    value = _require_int(name, value)
    if not I128_MIN <= value <= I128_MAX:
        raise InvalidArgumentError(f"{name} is outside the i128 range")
    return scval.to_int128(value)


def positive_i128(name: str, value: Any) -> xdr.SCVal:
    """An ``i128`` that must be > 0 (the contract's ``InvalidAmount`` rule)."""
    if _require_int(name, value) <= 0:
        raise InvalidArgumentError(f"{name} must be greater than zero")
    return i128(name, value)


def u64(name: str, value: Any) -> xdr.SCVal:
    value = _require_int(name, value)
    if not 0 <= value <= U64_MAX:
        raise InvalidArgumentError(f"{name} is outside the u64 range")
    return scval.to_uint64(value)


def u32(name: str, value: Any) -> xdr.SCVal:
    value = _require_int(name, value)
    if not 0 <= value <= U32_MAX:
        raise InvalidArgumentError(f"{name} is outside the u32 range")
    return scval.to_uint32(value)


def boolean(name: str, value: Any) -> xdr.SCVal:
    if not isinstance(value, bool):
        raise InvalidArgumentError(f"{name} must be a bool")
    return scval.to_bool(value)


def condition_ref(value: Any) -> xdr.SCVal:
    """The opaque ``condition_ref`` string, at most 64 UTF-8 bytes.

    It is public on-chain forever: pass an opaque id, never personal data.
    """
    if not isinstance(value, str):
        raise InvalidArgumentError("condition_ref must be a str")
    if len(value.encode("utf-8")) > MAX_CONDITION_REF_LEN:
        raise InvalidArgumentError(f"condition_ref is longer than {MAX_CONDITION_REF_LEN} bytes")
    return scval.to_string(value)


def option(value: T | None, encode: Callable[[T], xdr.SCVal]) -> xdr.SCVal:
    """A Soroban ``Option<T>``: ``None`` is void, ``Some(x)`` is ``x`` itself."""
    return scval.to_void() if value is None else encode(value)


# ── decoding ──


def _native(value: Any) -> Any:
    """``scval.to_native`` output with ``Address`` objects turned into strkeys."""
    if isinstance(value, Address):
        return value.address
    if isinstance(value, list):
        return [_native(v) for v in value]
    if isinstance(value, dict):
        return {_native(k): _native(v) for k, v in value.items()}
    return value


def to_native(value: xdr.SCVal) -> Any:
    return _native(scval.to_native(value))


def decode_u64(value: xdr.SCVal) -> int:
    return scval.from_uint64(value)


def decode_status(value: xdr.SCVal | Any) -> EscrowStatus:
    """A unit enum variant, which Soroban encodes as ``Vec[Symbol(name)]``."""
    native = to_native(value) if isinstance(value, xdr.SCVal) else value
    if isinstance(native, list) and len(native) == 1:
        native = native[0]
    try:
        return EscrowStatus(native)
    except ValueError as exc:
        raise ValueError(f"unknown EscrowStatus variant: {native!r}") from exc


_KNOWN_FIELDS = {
    "payer",
    "payee",
    "token",
    "amount",
    "condition_ref",
    "status",
    "releasers",
    "threshold",
    "refund_after",
    "notify_payee",
    "payees",
    "requires_acceptance",
    "accepted_at",
    "refund_to",
    "release_not_before",
    "fee_recipient",
    "fee_bps",
}


def decode_escrow(value: xdr.SCVal) -> Escrow:
    """``EscrowData`` (a struct, so an ``SCMap`` keyed by field symbols)."""
    data = to_native(value)
    if not isinstance(data, dict):
        raise ValueError("EscrowData must decode to a map")
    try:
        payees = tuple(
            PayeeShare(payee=share["payee"], basis_points=int(share["basis_points"]))
            for share in data.get("payees") or ()
        )
        return Escrow(
            payer=data["payer"],
            payee=data["payee"],
            token=data["token"],
            amount=int(data["amount"]),
            condition_ref=data["condition_ref"],
            status=decode_status(data["status"]),
            releasers=tuple(data["releasers"]),
            threshold=int(data["threshold"]),
            refund_after=data.get("refund_after"),
            notify_payee=bool(data.get("notify_payee", False)),
            payees=payees,
            requires_acceptance=data.get("requires_acceptance"),
            accepted_at=data.get("accepted_at"),
            refund_to=data.get("refund_to"),
            release_not_before=data.get("release_not_before"),
            fee_recipient=data.get("fee_recipient"),
            fee_bps=data.get("fee_bps"),
            extra={k: v for k, v in data.items() if k not in _KNOWN_FIELDS},
        )
    except KeyError as exc:
        raise ValueError(f"EscrowData is missing field {exc.args[0]!r}") from exc
