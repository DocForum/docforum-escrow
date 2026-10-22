"""Offline unit tests for the Python escrow SDK.

Nothing here touches the network: reads are driven through a fake Soroban RPC
server that records the envelope the client simulates, and writes go through a
fake server whose ``get_transaction`` returns a locally built result meta. The
live testnet path is covered by the opt-in ``integration`` tests.
"""

from __future__ import annotations

import time
from types import SimpleNamespace

import pytest
from stellar_sdk import Account, Keypair, scval, xdr
from stellar_sdk.strkey import StrKey
from stellar_sdk.soroban_rpc import GetTransactionStatus, SendTransactionStatus

from escrow_sdk import (
    ERROR_MESSAGES,
    MAX_CONDITION_REF_LENGTH,
    EscrowClient,
    EscrowCreated,
    EscrowError,
    EscrowErrorCode,
    EscrowInfo,
    EscrowStatus,
    error_from_code,
    error_from_message,
)

CONTRACT_ID = "CAFI5QOTNLK5OIHEHGGQ7B22RN5IUOFGKKEID2OQCZSCJAQS4FLSS2DR"
TOKEN_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
PAYEE = Keypair.random().public_key
RELEASER = Keypair.random().public_key


def native(value):
    """Decode an ScVal, unwrapping addresses to their strkey."""
    decoded = scval.to_native(value)
    address = getattr(decoded, "address", None)
    return address if isinstance(address, str) else decoded


def envelope_call(envelope: xdr.TransactionEnvelope):
    """The (contract, method, args) triple of a simulated invoke op."""
    operation = envelope.transaction.operations[0]
    invoke = operation.host_function.invoke_contract
    return invoke.contract_address, invoke.function_name.sc_symbol, invoke.args


class FakeServer:
    """Minimal Soroban RPC double: returns one prepared simulation result."""

    def __init__(self, result: xdr.SCVal | None = None, error: str | None = None) -> None:
        self.result = result
        self.error = error
        self.simulated: list[xdr.TransactionEnvelope] = []

    def simulate_transaction(self, envelope: xdr.TransactionEnvelope):
        self.simulated.append(envelope)
        if self.error is not None:
            return SimpleNamespace(error=self.error, results=[])
        return SimpleNamespace(error=None, results=[SimpleNamespace(xdr=self.result)])


class FakeWriteServer(FakeServer):
    """Fake server for the sign-and-submit path."""

    def __init__(self, return_value: int = 42, status: GetTransactionStatus = GetTransactionStatus.SUCCESS):
        super().__init__()
        self.return_value = return_value
        self.status = status
        self.sent: list[xdr.TransactionEnvelope] = []
        self.hashes: list[str] = []

    def load_account(self, public_key: str):
        return Account(public_key, 1)

    def prepare_transaction(self, envelope):
        return envelope

    def send_transaction(self, envelope):
        self.sent.append(envelope)
        return SimpleNamespace(status=SendTransactionStatus.PENDING, hash="ab" * 32)

    def get_transaction(self, tx_hash: str):
        self.hashes.append(tx_hash)
        return SimpleNamespace(
            status=self.status,
            result_meta_xdr=_meta_with_return_value(self.return_value),
            result_xdr=None,
        )


def _meta_with_return_value(value: int) -> str:
    changes = xdr.LedgerEntryChanges([])
    meta = xdr.TransactionMeta(
        3,
        v3=xdr.TransactionMetaV3(
            ext=xdr.ExtensionPoint(0),
            tx_changes_before=changes,
            operations=[],
            tx_changes_after=changes,
            soroban_meta=xdr.SorobanTransactionMeta(
                ext=xdr.SorobanTransactionMetaExt(0),
                events=[],
                return_value=scval.to_uint64(value),
                diagnostic_events=[],
            ),
        ),
    )
    return meta.to_xdr()


def escrow_map(**overrides) -> xdr.SCVal:
    fields = {
        "payer": scval.to_address(Keypair.random().public_key),
        "payee": scval.to_address(PAYEE),
        "token": scval.to_address(TOKEN_ID),
        "amount": scval.to_int128(10_000_000),
        "condition_ref": scval.to_string("invoice-42"),
        "releasers": scval.to_vec([scval.to_address(RELEASER)]),
        "threshold": scval.to_uint32(1),
        "refund_after": scval.to_void(),
        "notify_payee": scval.to_bool(False),
        "refund_to": scval.to_address(Keypair.random().public_key),
        "status": scval.to_vec([scval.to_symbol("Funded")]),
        "requires_acceptance": scval.to_bool(False),
        "accepted_at": scval.to_void(),
    }
    fields.update(overrides)
    return scval.to_map({scval.to_symbol(name): value for name, value in fields.items()})


def make_client(server=None, **kwargs) -> EscrowClient:
    return EscrowClient(CONTRACT_ID, server=server if server is not None else FakeServer(), **kwargs)


# -- reads -----------------------------------------------------------------


def test_get_status_decodes_the_contract_enum():
    server = FakeServer(scval.to_vec([scval.to_symbol("Refunded")]))
    assert make_client(server).get_status(1) is EscrowStatus.REFUNDED


@pytest.mark.parametrize("raw", ["Funded", ["Released"], ("Cancelled",)])
def test_get_status_accepts_scalar_and_vector_forms(raw):
    value = raw if isinstance(raw, str) else raw[0]
    server = FakeServer(scval.to_symbol(value) if isinstance(raw, str) else scval.to_vec([scval.to_symbol(value)]))
    assert make_client(server).get_status(1) is EscrowStatus(value)


def test_get_status_rejects_an_unknown_status():
    server = FakeServer(scval.to_vec([scval.to_symbol("Disputed")]))
    with pytest.raises(ValueError, match="not an escrow status"):
        make_client(server).get_status(1)


def test_get_status_encodes_the_escrow_id_as_u64():
    server = FakeServer(scval.to_vec([scval.to_symbol("Funded")]))
    make_client(server).get_status(7)

    contract, method, args = envelope_call(server.simulated[0])
    assert method == b"get_status"
    assert native(args[0]) == 7


def test_reads_use_the_client_contract_id():
    server = FakeServer(scval.to_vec([scval.to_symbol("Funded")]))
    make_client(server).get_status(1)

    contract, _, _ = envelope_call(server.simulated[0])
    assert contract.contract_id.hash == StrKey.decode_contract(CONTRACT_ID)


def test_get_escrow_decodes_the_full_record():
    server = FakeServer(escrow_map())
    info = make_client(server).get_escrow(3)

    assert isinstance(info, EscrowInfo)
    assert info.payee == PAYEE
    assert info.token == TOKEN_ID
    assert info.amount == 10_000_000
    assert info.condition_ref == "invoice-42"
    assert info.releasers == [RELEASER]
    assert info.threshold == 1
    assert info.refund_after is None
    assert info.notify_payee is False
    assert info.status is EscrowStatus.FUNDED


def test_get_escrow_maps_a_contract_error_to_a_typed_error():
    server = FakeServer(error="HostError: Error(Contract, #1)")
    with pytest.raises(EscrowError) as raised:
        make_client(server).get_escrow(99)

    assert raised.value.code == EscrowErrorCode.NOT_FOUND
    assert raised.value.name == "NotFound"


def test_non_contract_simulation_failure_is_not_an_escrow_error():
    server = FakeServer(error="host invocation failed: budget exceeded")
    with pytest.raises(RuntimeError):
        make_client(server).get_status(1)


@pytest.mark.parametrize("escrow_id", [0, -1])
def test_reads_reject_non_positive_escrow_ids(escrow_id):
    with pytest.raises(ValueError):
        make_client().get_status(escrow_id)


def test_reads_reject_non_integer_escrow_ids():
    with pytest.raises(TypeError):
        make_client().get_status(True)  # bool is an int subclass


# -- construction ----------------------------------------------------------


def test_rejects_an_invalid_contract_id():
    with pytest.raises(ValueError, match="contract_id"):
        EscrowClient("not-a-contract")


def test_rejects_an_account_address_as_the_contract_id():
    with pytest.raises(ValueError, match="contract_id"):
        EscrowClient(Keypair.random().public_key)


# -- writes ----------------------------------------------------------------


def test_create_escrow_returns_the_new_id_and_tx_hash():
    server = FakeWriteServer(return_value=17)
    client = make_client(server, secret_key=Keypair.random().secret)

    created = client.create_escrow(
        PAYEE,
        TOKEN_ID,
        10_000_000,
        "invoice-42",
        releaser=RELEASER,
    )

    assert isinstance(created, EscrowCreated)
    assert created.escrow_id == 17
    assert created.tx_hash == "ab" * 32
    assert server.hashes == ["ab" * 32]


def test_create_escrow_encodes_the_contract_arguments_in_order():
    server = FakeWriteServer()
    payer = Keypair.random()
    client = make_client(server, secret_key=payer.secret)

    client.create_escrow(PAYEE, TOKEN_ID, 10_000_000, "invoice-42", releaser=RELEASER)

    _, method, args = envelope_call(server.sent[0])
    assert method == b"create_escrow"
    decoded = [native(arg) for arg in args]
    assert decoded[0] == payer.public_key
    assert decoded[1] == PAYEE
    assert decoded[2] == TOKEN_ID
    assert decoded[3] == 10_000_000
    assert decoded[4] == "invoice-42"
    assert decoded[5] == RELEASER
    assert decoded[6] is None  # refund_after
    assert decoded[7] is False  # notify_payee
    assert decoded[8] is None  # refund_to


def test_create_escrow_defaults_the_releaser_to_the_signer():
    server = FakeWriteServer()
    payer = Keypair.random()
    client = make_client(server, secret_key=payer.secret)

    client.create_escrow(PAYEE, TOKEN_ID, 1, "ref")

    _, _, args = envelope_call(server.sent[0])
    assert native(args[5]) == payer.public_key


def test_create_escrow_rejects_a_past_refund_after():
    client = make_client(FakeWriteServer(), secret_key=Keypair.random().secret)
    with pytest.raises(ValueError, match="refund_after"):
        client.create_escrow(PAYEE, TOKEN_ID, 1, "ref", refund_after=int(time.time()) - 1)


@pytest.mark.parametrize("amount", [0, -1])
def test_create_escrow_rejects_non_positive_amounts(amount):
    client = make_client(FakeWriteServer(), secret_key=Keypair.random().secret)
    with pytest.raises(ValueError, match="amount"):
        client.create_escrow(PAYEE, TOKEN_ID, amount, "ref")


def test_create_escrow_rejects_an_oversized_condition_ref_in_bytes():
    client = make_client(FakeWriteServer(), secret_key=Keypair.random().secret)
    oversized = "é" * (MAX_CONDITION_REF_LENGTH // 2 + 1)  # 2 bytes per char
    with pytest.raises(ValueError, match="condition_ref"):
        client.create_escrow(PAYEE, TOKEN_ID, 1, oversized)


def test_create_escrow_rejects_a_non_contract_token():
    client = make_client(FakeWriteServer(), secret_key=Keypair.random().secret)
    with pytest.raises(ValueError, match="token"):
        client.create_escrow(PAYEE, PAYEE, 1, "ref")


def test_create_escrow_requires_a_signer():
    client = make_client(FakeWriteServer())
    with pytest.raises(ValueError, match="signer"):
        client.create_escrow(PAYEE, TOKEN_ID, 1, "ref")


def test_release_submits_the_release_entry_point():
    server = FakeWriteServer()
    caller = Keypair.random()
    client = make_client(server, secret_key=caller.secret)

    tx_hash = client.release(5)

    assert tx_hash == "ab" * 32
    _, method, args = envelope_call(server.sent[0])
    assert method == b"release"
    assert native(args[0]) == 5
    assert native(args[1]) == caller.public_key


def test_refund_submits_the_refund_entry_point_and_fails_typed():
    server = FakeWriteServer(status=GetTransactionStatus.FAILED)
    client = make_client(server, secret_key=Keypair.random().secret)

    with pytest.raises(RuntimeError, match="failed"):
        client.refund(5)

    _, method, _ = envelope_call(server.sent[0])
    assert method == b"refund"


# -- errors ----------------------------------------------------------------


def test_error_from_code_uses_the_contract_symbol():
    assert error_from_code(6).name == "BalanceMismatch"
    assert error_from_code(999).name == "UnknownError(999)"


def test_error_from_message_extracts_the_contract_code():
    error = error_from_message("HostError: Error(Contract, #15)")
    assert error is not None
    assert error.code == EscrowErrorCode.THRESHOLD_NOT_MET
    assert error.name == "ThresholdNotMet"
    assert "Error(Contract, #15)" in error.detail


def test_error_from_message_ignores_non_contract_failures():
    assert error_from_message("connection refused") is None


def test_error_message_includes_code_and_detail():
    error = EscrowError(code=2, detail="amount was zero")
    assert str(error) == "InvalidAmount (code 2): amount was zero"
    assert repr(error) == "EscrowError(code=2, name='InvalidAmount')"


def test_every_contract_code_has_a_symbol():
    assert set(ERROR_MESSAGES) == set(int(code) for code in EscrowErrorCode)
