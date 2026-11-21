from __future__ import annotations

import pytest
from stellar_sdk import Keypair, scval

from docforum_escrow import scval as sv
from docforum_escrow.errors import InvalidArgumentError
from docforum_escrow.types import EscrowStatus, PayeeShare

from .conftest import TOKEN_ID


@pytest.mark.parametrize("value", [0, 1, -1, 2**64, -(2**64), 2**127 - 1, -(2**127)])
def test_i128_round_trips_at_the_boundaries(value: int) -> None:
    assert scval.from_int128(sv.i128("amount", value)) == value


@pytest.mark.parametrize("value", [2**127, -(2**127) - 1])
def test_i128_rejects_out_of_range(value: int) -> None:
    with pytest.raises(InvalidArgumentError, match="i128"):
        sv.i128("amount", value)


@pytest.mark.parametrize("value", [1.0, "10", True, None])
def test_i128_rejects_non_ints(value: object) -> None:
    with pytest.raises(InvalidArgumentError):
        sv.i128("amount", value)


@pytest.mark.parametrize("value", [0, -5])
def test_amount_must_be_positive(value: int) -> None:
    with pytest.raises(InvalidArgumentError, match="greater than zero"):
        sv.positive_i128("amount", value)


def test_u64_and_u32_ranges() -> None:
    assert scval.from_uint64(sv.u64("id", 2**64 - 1)) == 2**64 - 1
    with pytest.raises(InvalidArgumentError):
        sv.u64("id", -1)
    with pytest.raises(InvalidArgumentError):
        sv.u64("id", 2**64)
    with pytest.raises(InvalidArgumentError):
        sv.u32("fee_bps", 2**32)


def test_addresses() -> None:
    account = Keypair.random().public_key
    assert scval.from_address(sv.address("payee", account)).address == account
    assert scval.from_address(sv.address("token", TOKEN_ID)).address == TOKEN_ID
    for bad in ("GBAD", "", 7):
        with pytest.raises(InvalidArgumentError):
            sv.address("payee", bad)


def test_condition_ref_byte_limit() -> None:
    assert scval.from_string(sv.condition_ref("a" * 64)) == b"a" * 64
    with pytest.raises(InvalidArgumentError, match="64 bytes"):
        sv.condition_ref("a" * 65)
    # 22 three-byte characters are 66 bytes even though len() is 22.
    with pytest.raises(InvalidArgumentError):
        sv.condition_ref("\u20ac" * 22)


def test_option_encodes_none_as_void() -> None:
    assert sv.option(None, lambda v: sv.u64("x", v)) == scval.to_void()
    assert scval.from_uint64(sv.option(5, lambda v: sv.u64("x", v))) == 5


def test_decode_status() -> None:
    assert sv.decode_status(scval.to_vec([scval.to_symbol("Released")])) is EscrowStatus.RELEASED
    with pytest.raises(ValueError):
        sv.decode_status(scval.to_vec([scval.to_symbol("Bogus")]))


def _escrow_map(**overrides: object) -> dict:
    payer, payee, releaser = (Keypair.random().public_key for _ in range(3))
    fields = {
        "payer": scval.to_address(payer),
        "payee": scval.to_address(payee),
        "token": scval.to_address(TOKEN_ID),
        "amount": scval.to_int128(2**100),
        "condition_ref": scval.to_string("order-42"),
        "status": scval.to_vec([scval.to_symbol("Funded")]),
        "releasers": scval.to_vec([scval.to_address(releaser)]),
        "threshold": scval.to_uint32(1),
        "refund_after": scval.to_uint64(1_900_000_000),
        "payees": scval.to_vec(
            [
                scval.to_map(
                    {
                        scval.to_symbol("payee"): scval.to_address(payee),
                        scval.to_symbol("basis_points"): scval.to_uint32(10_000),
                    }
                )
            ]
        ),
        "notify_payee": scval.to_bool(False),
        "requires_acceptance": scval.to_bool(False),
        "accepted_at": scval.to_void(),
        "refund_to": scval.to_address(payer),
        "release_not_before": scval.to_void(),
        "fee_recipient": scval.to_void(),
        "fee_bps": scval.to_void(),
    }
    fields.update(overrides)
    return {"fields": fields, "payer": payer, "payee": payee, "releaser": releaser}


def test_decode_escrow() -> None:
    built = _escrow_map(future_field=scval.to_uint32(7))
    value = scval.to_map({scval.to_symbol(k): v for k, v in built["fields"].items()})
    escrow = sv.decode_escrow(value)
    assert escrow.payer == built["payer"]
    assert escrow.payee == built["payee"]
    assert escrow.token == TOKEN_ID
    assert escrow.amount == 2**100
    assert escrow.condition_ref == "order-42"
    assert escrow.status is EscrowStatus.FUNDED
    assert escrow.releasers == (built["releaser"],)
    assert escrow.threshold == 1
    assert escrow.refund_after == 1_900_000_000
    assert escrow.payees == (PayeeShare(built["payee"], 10_000),)
    assert escrow.refund_to == built["payer"]
    assert escrow.accepted_at is None
    assert escrow.fee_bps is None
    assert escrow.extra == {"future_field": 7}


def test_decode_escrow_tolerates_older_deployments() -> None:
    built = _escrow_map()
    for missing in ("payees", "requires_acceptance", "accepted_at", "refund_to", "fee_bps"):
        del built["fields"][missing]
    value = scval.to_map({scval.to_symbol(k): v for k, v in built["fields"].items()})
    escrow = sv.decode_escrow(value)
    assert escrow.payees == ()
    assert escrow.requires_acceptance is None


def test_decode_escrow_missing_required_field() -> None:
    built = _escrow_map()
    del built["fields"]["amount"]
    value = scval.to_map({scval.to_symbol(k): v for k, v in built["fields"].items()})
    with pytest.raises(ValueError, match="amount"):
        sv.decode_escrow(value)
