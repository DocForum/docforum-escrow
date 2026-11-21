from __future__ import annotations

import json
from pathlib import Path

import pytest
from stellar_sdk import Address, Keypair, Network, scval, xdr
from stellar_sdk.soroban_rpc import GetTransactionStatus, SendTransactionStatus

import docforum_escrow as escrow
from docforum_escrow import EscrowClient, EscrowStatus

from .conftest import CONTRACT_ID, TOKEN_ID, FakeServer, contract_error_event

REPO = Path(__file__).resolve().parents[2]
SPEC = {f["name"]: f for f in json.loads((REPO / "contract-spec.json").read_text())["functions"]}

# Rust type in contract-spec.json -> SCVal type the client must send (Some/required).
RUST_TO_SCV = {
    "Address": xdr.SCValType.SCV_ADDRESS,
    "i128": xdr.SCValType.SCV_I128,
    "u64": xdr.SCValType.SCV_U64,
    "u32": xdr.SCValType.SCV_U32,
    "bool": xdr.SCValType.SCV_BOOL,
    "String": xdr.SCValType.SCV_STRING,
}


def spec_args(function: str) -> list[tuple[str, str]]:
    args = []
    for part in SPEC[function]["args"].split(","):
        part = part.strip()
        if not part or part.startswith("env:"):
            continue
        name, rust = (s.strip() for s in part.split(":", 1))
        args.append((name, rust))
    return args


def invoked(server: FakeServer, step: str = "prepare") -> tuple[str, list[xdr.SCVal]]:
    tx = next(tx for kind, tx in server.calls if kind == step)
    op = tx.transaction.operations[0]
    invoke = op.host_function.invoke_contract
    assert Address.from_xdr_sc_address(invoke.contract_address).address == CONTRACT_ID
    return invoke.function_name.sc_symbol.decode(), list(invoke.args)


def assert_matches_spec(function: str, args: list[xdr.SCVal]) -> None:
    expected = spec_args(function)
    assert len(args) == len(expected), f"{function} arity differs from contract-spec.json"
    for (name, rust), value in zip(expected, args, strict=True):
        optional = rust.startswith("Option<")
        inner = rust[len("Option<") : -1] if optional else rust
        if optional and value.type == xdr.SCValType.SCV_VOID:
            continue
        assert value.type == RUST_TO_SCV[inner], f"{function}.{name}: {value.type} for {rust}"


def client(server: FakeServer, signer: Keypair | None = None) -> EscrowClient:
    return EscrowClient(CONTRACT_ID, signer=signer, server=server)


# ── construction ──


def test_rejects_the_public_network() -> None:
    with pytest.raises(escrow.NetworkMismatchError):
        EscrowClient(CONTRACT_ID, network_passphrase=Network.PUBLIC_NETWORK_PASSPHRASE)


@pytest.mark.parametrize("bad", ["", "GABC", Keypair.random().public_key])
def test_rejects_a_bad_contract_id(bad: str) -> None:
    with pytest.raises(escrow.InvalidArgumentError):
        EscrowClient(bad, server=FakeServer())


def test_rejects_a_public_only_keypair(keypair: Keypair) -> None:
    with pytest.raises(escrow.InvalidArgumentError):
        EscrowClient(CONTRACT_ID, signer=Keypair.from_public_key(keypair.public_key))


def test_check_network() -> None:
    client(FakeServer()).check_network()
    with pytest.raises(escrow.NetworkMismatchError):
        client(FakeServer(passphrase="Standalone Network ; February 2017")).check_network()


def test_writes_need_a_signer() -> None:
    server = FakeServer()
    with pytest.raises(escrow.SignerRequiredError):
        client(server).release(1)
    assert server.calls == []


# ── create_escrow ──


def test_create_escrow_sends_the_spec_arguments_and_returns_the_id(keypair: Keypair) -> None:
    server = FakeServer(return_value=scval.to_uint64(42))
    payee = Keypair.random().public_key
    result = client(server, keypair).create_escrow(
        payee=payee,
        token=TOKEN_ID,
        amount=2**70,
        condition_ref="order-42",
        refund_after=1_900_000_000,
        fee_recipient=Keypair.random().public_key,
        fee_bps=250,
    )
    assert result.escrow_id == 42
    assert result.tx_hash == "ab" * 32
    assert result.ledger == 123

    function, args = invoked(server)
    assert function == "create_escrow"
    assert_matches_spec("create_escrow", args)
    assert scval.from_address(args[0]).address == keypair.public_key  # payer
    assert scval.from_address(args[1]).address == payee
    assert scval.from_int128(args[3]) == 2**70
    assert scval.from_address(args[5]).address == keypair.public_key  # releaser default
    assert scval.from_uint64(args[6]) == 1_900_000_000  # refund_after
    assert scval.from_bool(args[7]) is False  # notify_payee
    assert args[8].type == xdr.SCValType.SCV_VOID  # refund_to
    assert scval.from_uint32(args[10]) == 250  # fee_bps

    kinds = [kind for kind, _ in server.calls]
    assert kinds == ["load_account", "prepare", "send", "poll"]
    sent = next(tx for kind, tx in server.calls if kind == "send")
    assert len(sent.signatures) == 1


def test_create_escrow_optional_arguments_are_void(keypair: Keypair) -> None:
    server = FakeServer(return_value=scval.to_uint64(1))
    client(server, keypair).create_escrow(
        payee=Keypair.random().public_key, token=TOKEN_ID, amount=1, condition_ref="x"
    )
    _, args = invoked(server)
    assert_matches_spec("create_escrow", args)
    for index in (6, 8, 9, 10):  # refund_after, refund_to, fee_recipient, fee_bps
        assert args[index].type == xdr.SCValType.SCV_VOID


@pytest.mark.parametrize(
    "overrides",
    [
        {"amount": 0},
        {"amount": 2**127},
        {"condition_ref": "x" * 65},
        {"payee": "not-an-address"},
        {"payer": Keypair.random().public_key},
        {"fee_bps": 100},
        {"refund_after": -1},
    ],
)
def test_create_escrow_validates_before_any_request(keypair: Keypair, overrides: dict) -> None:
    server = FakeServer()
    kwargs = {
        "payee": Keypair.random().public_key,
        "token": TOKEN_ID,
        "amount": 10,
        "condition_ref": "x",
        **overrides,
    }
    with pytest.raises(escrow.InvalidArgumentError):
        client(server, keypair).create_escrow(**kwargs)
    assert server.calls == []


def test_simulation_contract_error_is_typed_and_nothing_is_sent(keypair: Keypair) -> None:
    server = FakeServer(prepare_error="HostError: Error(Contract, #8)\n\nEvent log...")
    with pytest.raises(escrow.DisallowedTokenError) as info:
        client(server, keypair).create_escrow(
            payee=Keypair.random().public_key, token=TOKEN_ID, amount=5, condition_ref="x"
        )
    assert info.value.code == 8
    assert "send" not in [kind for kind, _ in server.calls]


def test_simulation_failure_without_a_code(keypair: Keypair) -> None:
    server = FakeServer(prepare_error="HostError: Error(WasmVm, InvalidAction)")
    with pytest.raises(escrow.SimulationFailure):
        client(server, keypair).release(1)


def test_foreign_authorization_is_refused_before_signing(keypair: Keypair) -> None:
    payee = Keypair.random().public_key
    entry = xdr.SorobanAuthorizationEntry(
        credentials=xdr.SorobanCredentials(
            xdr.SorobanCredentialsType.SOROBAN_CREDENTIALS_ADDRESS,
            address=xdr.SorobanAddressCredentials(
                address=Address(payee).to_xdr_sc_address(),
                nonce=xdr.Int64(1),
                signature_expiration_ledger=xdr.Uint32(0),
                signature=scval.to_void(),
            ),
        ),
        root_invocation=xdr.SorobanAuthorizedInvocation(
            function=xdr.SorobanAuthorizedFunction(
                xdr.SorobanAuthorizedFunctionType.SOROBAN_AUTHORIZED_FUNCTION_TYPE_CONTRACT_FN,
                contract_fn=xdr.InvokeContractArgs(
                    contract_address=Address(CONTRACT_ID).to_xdr_sc_address(),
                    function_name=xdr.SCSymbol(b"create_escrow"),
                    args=[],
                ),
            ),
            sub_invocations=[],
        ),
    )
    server = FakeServer(add_auth=entry)
    with pytest.raises(escrow.UnsupportedAuthorizationError, match=payee):
        client(server, keypair).create_escrow(
            payee=payee, token=TOKEN_ID, amount=5, condition_ref="x", notify_payee=True
        )
    assert "send" not in [kind for kind, _ in server.calls]


# ── release / refund ──


@pytest.mark.parametrize("function", ["release", "refund"])
def test_settle_sends_the_spec_arguments(keypair: Keypair, function: str) -> None:
    server = FakeServer()
    result = getattr(client(server, keypair), function)(7)
    assert result.tx_hash == "ab" * 32
    name, args = invoked(server)
    assert name == function
    assert_matches_spec(function, args)
    assert scval.from_uint64(args[0]) == 7
    assert scval.from_address(args[1]).address == keypair.public_key


@pytest.mark.parametrize("function", ["release", "refund"])
def test_settle_caller_must_be_the_signer(keypair: Keypair, function: str) -> None:
    with pytest.raises(escrow.InvalidArgumentError):
        getattr(client(FakeServer(), keypair), function)(7, caller=Keypair.random().public_key)


def test_failed_transaction_maps_the_diagnostic_contract_code(keypair: Keypair) -> None:
    server = FakeServer(
        final_status=GetTransactionStatus.FAILED, failed_events=[contract_error_event(4)]
    )
    with pytest.raises(escrow.NotFundedError):
        client(server, keypair).release(7)


def test_failed_transaction_without_a_code(keypair: Keypair) -> None:
    server = FakeServer(final_status=GetTransactionStatus.FAILED)
    with pytest.raises(escrow.SubmissionFailure):
        client(server, keypair).refund(7)


def test_send_error_maps_the_diagnostic_contract_code(keypair: Keypair) -> None:
    server = FakeServer(
        send_status=SendTransactionStatus.ERROR, send_events=[contract_error_event(3)]
    )
    with pytest.raises(escrow.UnauthorizedError):
        client(server, keypair).release(7)
    assert "poll" not in [kind for kind, _ in server.calls]


def test_send_try_again_later(keypair: Keypair) -> None:
    server = FakeServer(send_status=SendTransactionStatus.TRY_AGAIN_LATER)
    with pytest.raises(escrow.SubmissionFailure, match="TRY_AGAIN_LATER"):
        client(server, keypair).release(7)


def test_poll_timeout(keypair: Keypair) -> None:
    server = FakeServer(final_status=GetTransactionStatus.NOT_FOUND)
    with pytest.raises(escrow.RequestTimeoutError):
        client(server, keypair).release(7)


# ── reads ──


def test_get_status_without_a_signer() -> None:
    server = FakeServer(read_result=scval.to_vec([scval.to_symbol("Refunded")]))
    assert client(server).get_status(3) is EscrowStatus.REFUNDED
    name, args = invoked(server, "simulate")
    assert name == "get_status"
    assert_matches_spec("get_status", args)
    tx = server.calls[0][1]
    assert tx.transaction.source.account_id.startswith("GAAAA")
    assert tx.signatures == []


def test_get_escrow_unknown_id_is_not_found() -> None:
    server = FakeServer(read_error="HostError: Error(Contract, #1)")
    with pytest.raises(escrow.NotFoundError):
        client(server).get_escrow(999)
    _, args = invoked(server, "simulate")
    assert_matches_spec("get_escrow", args)


def test_get_escrow_decodes(keypair: Keypair) -> None:
    payee = Keypair.random().public_key
    record = scval.to_map(
        {
            scval.to_symbol("payer"): scval.to_address(keypair.public_key),
            scval.to_symbol("payee"): scval.to_address(payee),
            scval.to_symbol("token"): scval.to_address(TOKEN_ID),
            scval.to_symbol("amount"): scval.to_int128(10_000_000),
            scval.to_symbol("condition_ref"): scval.to_string("order-42"),
            scval.to_symbol("status"): scval.to_vec([scval.to_symbol("Funded")]),
            scval.to_symbol("releasers"): scval.to_vec([scval.to_address(keypair.public_key)]),
            scval.to_symbol("threshold"): scval.to_uint32(1),
            scval.to_symbol("refund_after"): scval.to_void(),
        }
    )
    got = client(FakeServer(read_result=record), keypair).get_escrow(1)
    assert got.amount == 10_000_000
    assert got.releasers == (keypair.public_key,)
    assert got.status is EscrowStatus.FUNDED


def test_read_with_no_result_is_a_simulation_failure() -> None:
    with pytest.raises(escrow.SimulationFailure):
        client(FakeServer()).get_status(1)
