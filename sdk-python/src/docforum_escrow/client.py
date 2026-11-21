"""A thin, synchronous Python client for the ``docforum-escrow`` contract.

It mirrors the TypeScript SDK's core surface (``createEscrow``,
``getStatus``, ``getEscrow``, ``release``, ``refund``) on top of the Stellar
Python SDK's Soroban RPC client. Every state-changing call runs the full
Soroban flow explicitly:

1. load the signer's account for its sequence number;
2. build an ``InvokeHostFunction`` transaction and ``prepare_transaction``
   it (simulate, then apply the footprint, resource fee and auth entries);
3. sign the envelope with the configured keypair;
4. ``send_transaction``, then poll until the transaction is final;
5. decode the return value from the transaction meta.

A contract error during simulation is raised as a typed
:class:`~docforum_escrow.errors.ContractError` before any fee is spent.

Testnet and local networks only: the client refuses the public-network
passphrase (``ARCHITECTURE_ESSENTIALS.md`` hard rule 4).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

from stellar_sdk import (
    Account,
    Address,
    Keypair,
    Network,
    SorobanServer,
    StrKey,
    TransactionBuilder,
    TransactionEnvelope,
    xdr,
)
from stellar_sdk.exceptions import (
    BaseRequestError,
    PrepareTransactionException,
    SdkError,
)
from stellar_sdk.soroban_rpc import (
    GetTransactionResponse,
    GetTransactionStatus,
    SendTransactionStatus,
)

from . import scval as sv
from .errors import (
    EscrowError,
    InvalidArgumentError,
    NetworkMismatchError,
    RequestTimeoutError,
    SignerRequiredError,
    SimulationFailure,
    SubmissionFailure,
    UnsupportedAuthorizationError,
    contract_error,
    to_escrow_error,
)
from .types import CreateEscrowResult, Escrow, EscrowStatus, TxResult

__all__ = ["EscrowClient", "TESTNET_RPC_URL", "TESTNET_PASSPHRASE"]

TESTNET_RPC_URL = "https://soroban-testnet.stellar.org"
TESTNET_PASSPHRASE = Network.TESTNET_NETWORK_PASSPHRASE
_PUBLIC_PASSPHRASE = Network.PUBLIC_NETWORK_PASSPHRASE
# Simulation needs a source account but never checks it exists, so reads
# without a signer use this all-zero account (the same trick the TS SDK uses).
_READ_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"


class EscrowClient:
    """Client for one deployed escrow contract.

    :param contract_id: the escrow contract's ``C...`` address.
    :param rpc_url: Soroban RPC endpoint; defaults to the SDF testnet RPC.
    :param network_passphrase: defaults to testnet. The public network is
        rejected with :class:`~docforum_escrow.errors.NetworkMismatchError`.
    :param signer: keypair that pays fees and authorizes calls as payer or
        releaser. Reads work without one; writes raise
        :class:`~docforum_escrow.errors.SignerRequiredError`.
    :param server: an existing ``SorobanServer`` (or a test double); when
        given, ``rpc_url`` is ignored.
    :param base_fee: inclusion fee in stroops, before the resource fee.
    :param tx_timeout: seconds a built transaction stays valid.
    :param poll_attempts: how many times to poll ``getTransaction`` (about
        one second apart) before raising ``RequestTimeoutError``.
    """

    def __init__(
        self,
        contract_id: str,
        *,
        rpc_url: str = TESTNET_RPC_URL,
        network_passphrase: str = TESTNET_PASSPHRASE,
        signer: Keypair | None = None,
        server: Any | None = None,
        base_fee: int = 100,
        tx_timeout: int = 300,
        poll_attempts: int = 60,
    ) -> None:
        if not isinstance(contract_id, str) or not StrKey.is_valid_contract(contract_id):
            raise InvalidArgumentError(
                f"contract_id is not a C... contract address: {contract_id!r}"
            )
        if network_passphrase == _PUBLIC_PASSPHRASE:
            raise NetworkMismatchError(
                "docforum-escrow is testnet-only; the public network is refused "
                "until the Phase E4 security review is complete",
                expected=TESTNET_PASSPHRASE,
                actual=network_passphrase,
            )
        if signer is not None and signer.signing_key is None:
            raise InvalidArgumentError("signer must be a Keypair with a secret key")
        self.contract_id = contract_id
        self.network_passphrase = network_passphrase
        self.signer = signer
        self.server = server if server is not None else SorobanServer(rpc_url)
        self.base_fee = base_fee
        self.tx_timeout = tx_timeout
        self.poll_attempts = poll_attempts

    # ── network ──

    def check_network(self) -> None:
        """Raise ``NetworkMismatchError`` if the RPC serves another network."""
        try:
            actual = self.server.get_network().passphrase
        except (BaseRequestError, SdkError) as exc:
            raise to_escrow_error(exc) from exc
        if actual != self.network_passphrase:
            raise NetworkMismatchError(
                f'RPC network passphrase mismatch: expected "{self.network_passphrase}", '
                f'got "{actual}"',
                expected=self.network_passphrase,
                actual=actual,
            )

    # ── writes ──

    def create_escrow(
        self,
        *,
        payee: str,
        token: str,
        amount: int,
        condition_ref: str,
        releaser: str | None = None,
        payer: str | None = None,
        refund_after: int | None = None,
        notify_payee: bool = False,
        refund_to: str | None = None,
        fee_recipient: str | None = None,
        fee_bps: int | None = None,
    ) -> CreateEscrowResult:
        """Lock ``amount`` of ``token`` from the payer into a new escrow.

        ``payer`` and ``releaser`` default to the signer. ``payer``, if given,
        must be the signer: this client authorizes the transfer itself.
        ``amount`` is an ``int`` in the token's smallest unit (an ``i128``
        on-chain). ``condition_ref`` is public on-chain forever: use an opaque
        id. ``fee_recipient`` and ``fee_bps`` are set together or not at all.
        """
        signer = self._require_signer()
        payer = signer.public_key if payer is None else payer
        if payer != signer.public_key:
            raise InvalidArgumentError("payer must be the signer's address")
        releaser = signer.public_key if releaser is None else releaser
        if (fee_recipient is None) != (fee_bps is None):
            raise InvalidArgumentError("fee_recipient and fee_bps must be set together")
        args = [
            sv.address("payer", payer),
            sv.address("payee", payee),
            sv.address("token", token),
            sv.positive_i128("amount", amount),
            sv.condition_ref(condition_ref),
            sv.address("releaser", releaser),
            sv.option(refund_after, lambda v: sv.u64("refund_after", v)),
            sv.boolean("notify_payee", notify_payee),
            sv.option(refund_to, lambda v: sv.address("refund_to", v)),
            sv.option(fee_recipient, lambda v: sv.address("fee_recipient", v)),
            sv.option(fee_bps, lambda v: sv.u32("fee_bps", v)),
        ]
        response, value = self._invoke("create_escrow", args)
        return CreateEscrowResult(
            escrow_id=sv.decode_u64(value),
            tx_hash=response.transaction_hash or "",
            ledger=response.ledger,
        )

    def release(self, escrow_id: int, *, caller: str | None = None) -> TxResult:
        """Pay the escrow out to its payee. The signer must be a releaser."""
        return self._settle("release", escrow_id, caller)

    def refund(self, escrow_id: int, *, caller: str | None = None) -> TxResult:
        """Return the escrow to its ``refund_to`` address.

        The signer must be a releaser, or anyone once ``refund_after`` passed.
        """
        return self._settle("refund", escrow_id, caller)

    # ── reads ──

    def get_status(self, escrow_id: int) -> EscrowStatus:
        """The escrow's status. Raises ``NotFoundError`` for an unknown id."""
        return sv.decode_status(self._read("get_status", [sv.u64("escrow_id", escrow_id)]))

    def get_escrow(self, escrow_id: int) -> Escrow:
        """The full escrow record. Raises ``NotFoundError`` for an unknown id."""
        return sv.decode_escrow(self._read("get_escrow", [sv.u64("escrow_id", escrow_id)]))

    # ── internals ──

    def _require_signer(self) -> Keypair:
        if self.signer is None:
            raise SignerRequiredError("this call signs a transaction; pass signer= to EscrowClient")
        return self.signer

    def _settle(self, function: str, escrow_id: int, caller: str | None) -> TxResult:
        signer = self._require_signer()
        caller = signer.public_key if caller is None else caller
        if caller != signer.public_key:
            raise InvalidArgumentError("caller must be the signer's address")
        args = [sv.u64("escrow_id", escrow_id), sv.address("caller", caller)]
        response, _ = self._invoke(function, args)
        return TxResult(tx_hash=response.transaction_hash or "", ledger=response.ledger)

    def _build(
        self, source: Account, function: str, args: Sequence[xdr.SCVal]
    ) -> TransactionEnvelope:
        return (
            TransactionBuilder(source, self.network_passphrase, base_fee=self.base_fee)
            .append_invoke_contract_function_op(self.contract_id, function, list(args))
            .set_timeout(self.tx_timeout)
            .build()
        )

    def _read(self, function: str, args: Sequence[xdr.SCVal]) -> xdr.SCVal:
        source = self.signer.public_key if self.signer is not None else _READ_SOURCE
        tx = self._build(Account(source, 0), function, args)
        try:
            sim = self.server.simulate_transaction(tx)
        except (BaseRequestError, SdkError) as exc:
            raise to_escrow_error(exc) from exc
        if sim.error:
            raise to_escrow_error(sim.error)
        if not sim.results or sim.results[0].xdr is None:
            raise SimulationFailure(f"{function}: simulation returned no result")
        return xdr.SCVal.from_xdr(sim.results[0].xdr)

    def _invoke(
        self, function: str, args: Sequence[xdr.SCVal]
    ) -> tuple[GetTransactionResponse, xdr.SCVal]:
        signer = self._require_signer()
        try:
            account = self.server.load_account(signer.public_key)
            prepared = self.server.prepare_transaction(self._build(account, function, args))
        except PrepareTransactionException as exc:
            detail = exc.simulate_transaction_response.error or exc.message
            raise to_escrow_error(detail, "simulation") from exc
        except EscrowError:
            raise
        except (BaseRequestError, SdkError) as exc:
            raise to_escrow_error(exc, "simulation") from exc

        needs = sorted(set(_address_auth(prepared)))
        if needs:
            raise UnsupportedAuthorizationError(
                f"{function} needs a separate authorization from {', '.join(needs)}, "
                "which this client does not sign (for create_escrow, notify_payee=True "
                "requires the payee's signature)"
            )

        prepared.sign(signer)
        try:
            sent = self.server.send_transaction(prepared)
        except (BaseRequestError, SdkError) as exc:
            raise to_escrow_error(exc, "submission") from exc
        if sent.status != SendTransactionStatus.PENDING:
            code = _contract_code(sent.diagnostic_events_xdr or [])
            if code is not None:
                raise contract_error(code)
            raise SubmissionFailure(
                f"{function}: send_transaction returned {sent.status.value}"
                + (f" ({sent.error_result_xdr})" if sent.error_result_xdr else "")
            )

        try:
            final = self.server.poll_transaction(sent.hash, max_attempts=self.poll_attempts)
        except (BaseRequestError, SdkError) as exc:
            raise to_escrow_error(exc, "submission") from exc
        if final.status == GetTransactionStatus.NOT_FOUND:
            raise RequestTimeoutError(
                f"{function}: transaction {sent.hash} not final after polling"
            )
        if final.status == GetTransactionStatus.FAILED:
            code = _contract_code(_failed_events(final))
            if code is not None:
                raise contract_error(code)
            raise SubmissionFailure(f"{function}: transaction {sent.hash} failed")
        return final, _return_value(final)


def _address_auth(envelope: TransactionEnvelope) -> list[str]:
    """Addresses of auth entries the envelope signature alone does not cover.

    The signer's own authorization comes back from simulation as
    source-account credentials, which the envelope signature satisfies; any
    address-credential entry belongs to someone else.
    """
    addresses: list[str] = []
    for op in envelope.transaction.operations:
        for entry in getattr(op, "auth", None) or []:
            creds = entry.credentials
            for attr in ("address", "address_v2", "address_with_delegates"):
                inner = getattr(creds, attr, None)
                if inner is not None:
                    target = getattr(inner, "address", None) or getattr(
                        getattr(inner, "address_credentials", None), "address", None
                    )
                    addresses.append(
                        Address.from_xdr_sc_address(target).address if target is not None else "?"
                    )
                    break
    return addresses


def _return_value(response: GetTransactionResponse) -> xdr.SCVal:
    if not response.result_meta_xdr:
        raise SubmissionFailure("transaction succeeded but carried no result meta")
    meta = xdr.TransactionMeta.from_xdr(response.result_meta_xdr)
    body = meta.v4 or meta.v3
    if body is None or body.soroban_meta is None or body.soroban_meta.return_value is None:
        raise SubmissionFailure("transaction meta has no Soroban return value")
    return body.soroban_meta.return_value


def _failed_events(response: GetTransactionResponse) -> list[str]:
    events = list(response.diagnostic_events_xdr or [])
    if response.result_meta_xdr:
        try:
            meta = xdr.TransactionMeta.from_xdr(response.result_meta_xdr)
            if meta.v4 is not None:
                events += [e.to_xdr() for e in meta.v4.diagnostic_events]
            elif meta.v3 is not None and meta.v3.soroban_meta is not None:
                events += [e.to_xdr() for e in meta.v3.soroban_meta.diagnostic_events]
        except Exception:  # best effort: fall back to SubmissionFailure
            pass
    return events


def _contract_code(events_xdr: Iterable[str]) -> int | None:
    """The first ``Error(Contract, #n)`` carried in diagnostic events."""
    for raw in events_xdr:
        try:
            event = xdr.DiagnosticEvent.from_xdr(raw).event
        except Exception:
            continue
        body = event.body.v0
        if body is None:
            continue
        for value in [*body.topics, body.data]:
            code = _find_error(value)
            if code is not None:
                return code
    return None


def _find_error(value: xdr.SCVal) -> int | None:
    if value.type == xdr.SCValType.SCV_ERROR and value.error is not None:
        if (
            value.error.type == xdr.SCErrorType.SCE_CONTRACT
            and value.error.contract_code is not None
        ):
            return value.error.contract_code.uint32
        return None
    if value.type == xdr.SCValType.SCV_VEC and value.vec is not None:
        for item in value.vec.sc_vec:
            code = _find_error(item)
            if code is not None:
                return code
    return None
