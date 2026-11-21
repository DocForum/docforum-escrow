from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

import docforum_escrow as escrow
from docforum_escrow.errors import (
    CONTRACT_ERROR_NAMES,
    ContractError,
    NetworkMismatchError,
    RequestTimeoutError,
    SimulationFailure,
    SubmissionFailure,
    contract_error,
    contract_error_name,
    find_contract_code,
    to_escrow_error,
)

REPO = Path(__file__).resolve().parents[2]


def test_error_map_matches_contract_spec() -> None:
    spec = json.loads((REPO / "contract-spec.json").read_text())
    assert CONTRACT_ERROR_NAMES == {e["code"]: e["name"] for e in spec["errors"]}


def test_error_map_matches_contract_source() -> None:
    source = (REPO / "contracts/escrow/src/errors.rs").read_text()
    declared = {int(c): n for n, c in re.findall(r"^\s*(\w+)\s*=\s*(\d+),", source, re.M)}
    assert CONTRACT_ERROR_NAMES == declared


def test_error_map_matches_typescript_sdk() -> None:
    generated = (REPO / "sdk/src/contract-errors.generated.ts").read_text()
    ts = {int(c): n for c, n in re.findall(r'^\s*(\d+):\s*"(\w+)"', generated, re.M)}
    assert CONTRACT_ERROR_NAMES == ts


@pytest.mark.parametrize("code,name", sorted(CONTRACT_ERROR_NAMES.items()))
def test_every_code_has_an_exported_class(code: int, name: str) -> None:
    error = contract_error(code)
    assert type(error) is not ContractError
    assert error.code == code
    assert error.contract_error == name
    assert contract_error_name(code) == name
    assert getattr(escrow, type(error).__name__) is type(error)


def test_class_names_follow_the_typescript_sdk() -> None:
    assert type(contract_error(1)).__name__ == "NotFoundError"
    assert type(contract_error(2)).__name__ == "InvalidAmountContractError"
    assert type(contract_error(3)).__name__ == "UnauthorizedError"
    assert type(contract_error(4)).__name__ == "NotFundedError"
    # Not OverflowError: that would shadow the builtin.
    assert type(contract_error(12)).__name__ == "OverflowContractError"


def test_unknown_code_is_kept() -> None:
    error = contract_error(999)
    assert type(error) is ContractError
    assert error.code == 999
    assert error.contract_error == "UnknownContractError"
    assert contract_error_name(999) is None


@pytest.mark.parametrize(
    "message,code",
    [
        ("HostError: Error(Contract, #1)", 1),
        ("host invocation failed\nError(Contract, #15)\nevent log", 15),
        ("contract error #4", 4),
        ("Escrow failed with error code: 25", 25),
        ("Error(WasmVm, InvalidAction)", None),
        ("nothing here", None),
    ],
)
def test_find_contract_code(message: str, code: int | None) -> None:
    assert find_contract_code(message) == code


def test_to_escrow_error_categories() -> None:
    cause = RuntimeError("HostError: Error(Contract, #3)")
    error = to_escrow_error(cause)
    assert isinstance(error, escrow.UnauthorizedError)
    assert error.__cause__ is cause
    assert isinstance(to_escrow_error("request timed out"), RequestTimeoutError)
    assert isinstance(to_escrow_error("network passphrase mismatch"), NetworkMismatchError)
    assert isinstance(to_escrow_error("tx_bad_auth"), SimulationFailure)
    assert isinstance(to_escrow_error("boom", "submission"), SubmissionFailure)
    assert isinstance(to_escrow_error("boom"), SimulationFailure)
    already = escrow.NotFoundError()
    assert to_escrow_error(already) is already


def test_errors_share_one_base() -> None:
    for cls in (ContractError, RequestTimeoutError, SimulationFailure, SubmissionFailure):
        assert issubclass(cls, escrow.EscrowError)
    assert issubclass(escrow.InvalidArgumentError, ValueError)
