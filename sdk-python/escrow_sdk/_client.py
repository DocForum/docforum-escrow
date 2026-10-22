"""Client for the docforum-escrow Soroban contract.

Mirrors the TypeScript SDK's surface in ``sdk/src/index.ts``: raw ``int``
amounts in the token's smallest unit, typed contract errors, and no PHI or
healthcare concepts (hard rule 1). Defaults are testnet-only (hard rule 4).

Reads are simulated against Soroban RPC with the protocol's null account, so
they need no keypair. Writes need a signer: pass ``secret_key`` to the
constructor, or a ``Keypair`` as ``payer``/``caller`` per call.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from enum import Enum
from typing import Any, Iterable, List, Mapping, Optional, Sequence

from stellar_sdk import (
    Account,
    Keypair,
    Network,
    SorobanServer,
    TransactionBuilder,
    scval,
    xdr,
)
from stellar_sdk.soroban_rpc import GetTransactionStatus, SendTransactionStatus
from stellar_sdk.strkey import StrKey

from ._errors import EscrowError, error_from_message

TESTNET_RPC_URL = "https://soroban-testnet.stellar.org"
TESTNET_NETWORK_PASSPHRASE = Network.TESTNET_NETWORK_PASSPHRASE

#: Protocol-level placeholder used to simulate read-only calls without an
#: account: the RPC never bills or sequences it.
NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"

BASE_FEE = 100

#: Maximum ``condition_ref`` length in bytes — must match the contract's bound
#: (``contracts/escrow/src/lib.rs``). Validated client-side so callers fail
#: fast instead of paying network fees for a rejected transaction.
MAX_CONDITION_REF_LENGTH = 64

#: Maximum number of addresses in one escrow's releaser set — must match the
#: contract's ``MAX_RELEASERS`` (docs/adr/0007).
MAX_RELEASERS = 10

#: ``i128`` upper bound, the contract's amount type.
MAX_AMOUNT = 2**127 - 1


class EscrowStatus(str, Enum):
    """Lifecycle status of one escrow (the contract's ``Status`` enum)."""

    FUNDED = "Funded"
    RELEASED = "Released"
    REFUNDED = "Refunded"
    CANCELLED = "Cancelled"


@dataclass(frozen=True)
class EscrowInfo:
    """Everything the contract stores about one escrow."""

    payer: str
    payee: str
    token: str
    amount: int
    condition_ref: str
    releasers: List[str]
    threshold: int
    refund_after: Optional[int]
    notify_payee: bool
    refund_to: str
    status: EscrowStatus

    @classmethod
    def from_native(cls, data: Mapping[str, Any]) -> "EscrowInfo":
        return cls(
            payer=_address(data["payer"]),
            payee=_address(data["payee"]),
            token=_address(data["token"]),
            amount=int(data["amount"]),
            condition_ref=str(data["condition_ref"]),
            releasers=[_address(item) for item in data.get("releasers") or []],
            threshold=int(data["threshold"]),
            refund_after=None if data.get("refund_after") is None else int(data["refund_after"]),
            notify_payee=bool(data.get("notify_payee")),
            refund_to=_address(data["refund_to"]),
            status=_status_of(data.get("status")),
        )


@dataclass(frozen=True)
class EscrowCreated:
    """Result of ``create_escrow``: the new id and the funding transaction."""

    escrow_id: Optional[int]
    tx_hash: str


def _address(value: Any) -> str:
    """Normalise a decoded ScVal address to its strkey string."""
    if isinstance(value, str):
        return value
    for attribute in ("address", "value"):
        candidate = getattr(value, attribute, None)
        if isinstance(candidate, str):
            return candidate
        if candidate is not None:
            return str(candidate)
    return str(value)


def _status_of(value: Any) -> EscrowStatus:
    """The contract returns its enum as a one-element vector of symbols."""
    if isinstance(value, (list, tuple)):
        if len(value) != 1:
            raise ValueError(f"not an escrow status: {value!r}")
        value = value[0]
    try:
        return EscrowStatus(value)
    except ValueError as error:
        raise ValueError(f"not an escrow status: {value!r}") from error


def _require_int(name: str, value: Any, minimum: int, maximum: Optional[int] = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} must be an int, got {type(value).__name__}")
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}, got {value}")
    if maximum is not None and value > maximum:
        raise ValueError(f"{name} must be at most {maximum}, got {value}")
    return value


def _require_address(name: str, value: str, *, contract: bool = False) -> str:
    if not isinstance(value, str) or not (
        StrKey.is_valid_contract(value) if contract else StrKey.is_valid_ed25519_public_key(value)
    ):
        kind = "contract address (C...)" if contract else "account address (G...)"
        raise ValueError(f"{name} must be a valid Stellar {kind}, got {value!r}")
    return value


class EscrowClient:
    """Thin client for the docforum-escrow contract.

    ``contract_id`` is the deployed escrow contract's ``C...`` address.
    Read calls (``get_status``, ``get_escrow``) never need a keypair; they
    simulate the call against RPC with the null account.
    """

    def __init__(
        self,
        contract_id: str,
        *,
        rpc_url: str = TESTNET_RPC_URL,
        network_passphrase: str = TESTNET_NETWORK_PASSPHRASE,
        secret_key: Optional[str] = None,
        server: Any = None,
        poll_interval_seconds: float = 1.0,
        tx_timeout_seconds: float = 30.0,
    ) -> None:
        self._contract_id = _require_address("contract_id", contract_id, contract=True)
        self._network_passphrase = network_passphrase
        self._server = server if server is not None else SorobanServer(rpc_url)
        self._poll_interval_seconds = poll_interval_seconds
        self._tx_timeout_seconds = tx_timeout_seconds
        self._signer = Keypair.from_secret(secret_key) if secret_key else None

    # -- reads ------------------------------------------------------------

    def _build_read_transaction(self, method: str, args: Sequence[xdr.SCVal]) -> Any:
        return (
            TransactionBuilder(
                Account(NULL_ACCOUNT, 0),
                self._network_passphrase,
                base_fee=BASE_FEE,
            )
            .append_invoke_contract_function_op(self._contract_id, method, list(args))
            .set_timeout(int(self._tx_timeout_seconds))
            .build()
        )

    def _simulate(self, method: str, args: Sequence[xdr.SCVal]) -> Any:
        response = self._server.simulate_transaction(self._build_read_transaction(method, args))
        error = getattr(response, "error", None)
        if error:
            raise error_from_message(str(error)) or RuntimeError(
                f"Simulating {method} on {self._contract_id} failed: {error}"
            )
        results = getattr(response, "results", None) or []
        if not results:
            raise RuntimeError(f"Simulating {method} returned no result")
        return scval.to_native(results[0].xdr)

    def get_status(self, escrow_id: int) -> EscrowStatus:
        """Read-only status query. Throws ``ValueError`` if the id is unknown."""
        _require_int("escrow_id", escrow_id, 1)
        return _status_of(self._simulate("get_status", [scval.to_uint64(escrow_id)]))

    def get_escrow(self, escrow_id: int) -> EscrowInfo:
        """Read-only: everything stored about ``escrow_id``."""
        _require_int("escrow_id", escrow_id, 1)
        return EscrowInfo.from_native(self._simulate("get_escrow", [scval.to_uint64(escrow_id)]))

    # -- writes -----------------------------------------------------------

    def _signer_for(self, signer: Optional[Keypair]) -> Keypair:
        resolved = signer or self._signer
        if resolved is None:
            raise ValueError(
                "This call needs a signer: pass secret_key to the client or a Keypair per call."
            )
        return resolved

    def _invoke(self, method: str, args: Sequence[xdr.SCVal], signer: Keypair) -> tuple[str, Any]:
        """Sign and submit one write call; returns ``(tx_hash, response)``."""
        account = self._server.load_account(signer.public_key)
        transaction = (
            TransactionBuilder(account, self._network_passphrase, base_fee=BASE_FEE)
            .append_invoke_contract_function_op(self._contract_id, method, list(args))
            .set_timeout(int(self._tx_timeout_seconds))
            .build()
        )
        prepared = self._server.prepare_transaction(transaction)
        prepared.sign(signer)
        sent = self._server.send_transaction(prepared)
        if sent.status == SendTransactionStatus.ERROR:
            detail = str(getattr(sent, "error_result_xdr", "") or "transaction rejected")
            raise error_from_message(detail) or RuntimeError(f"{method} was rejected: {detail}")
        return sent.hash, self._await_transaction(sent.hash)

    def _await_transaction(self, tx_hash: str) -> Any:
        deadline = time.monotonic() + self._tx_timeout_seconds
        while time.monotonic() < deadline:
            response = self._server.get_transaction(tx_hash)
            if response.status == GetTransactionStatus.SUCCESS:
                return response
            if response.status == GetTransactionStatus.FAILED:
                detail = str(getattr(response, "result_xdr", "") or "transaction failed")
                raise error_from_message(detail) or RuntimeError(f"Transaction {tx_hash} failed")
            time.sleep(self._poll_interval_seconds)
        raise TimeoutError(f"Transaction {tx_hash} was not confirmed within {self._tx_timeout_seconds}s")

    @staticmethod
    def _return_value(response: Any) -> Any:
        """Decode a submitted transaction's return value, when the RPC sent it."""
        meta_xdr = getattr(response, "result_meta_xdr", None)
        if not meta_xdr:
            return None
        meta = xdr.TransactionMeta.from_xdr(meta_xdr)
        soroban_meta = getattr(getattr(meta, "v3", None), "soroban_meta", None)
        if soroban_meta is None:
            return None
        return scval.to_native(soroban_meta.return_value)

    def create_escrow(
        self,
        payee: str,
        token: str,
        amount: int,
        condition_ref: str,
        *,
        releaser: Optional[str] = None,
        refund_after: Optional[int] = None,
        notify_payee: bool = False,
        refund_to: Optional[str] = None,
        payer: Optional[Keypair] = None,
    ) -> EscrowCreated:
        """Locks ``amount`` of ``token`` from the payer, held for ``payee``."""
        signer = self._signer_for(payer)
        _require_address("payee", payee)
        _require_address("token", token, contract=True)
        _require_int("amount", amount, 1, MAX_AMOUNT)
        if not isinstance(condition_ref, str):
            raise TypeError("condition_ref must be a str")
        if len(condition_ref.encode("utf-8")) > MAX_CONDITION_REF_LENGTH:
            raise ValueError(
                f"condition_ref must be at most {MAX_CONDITION_REF_LENGTH} bytes, "
                f"got {len(condition_ref.encode('utf-8'))}"
            )
        releaser_address = _require_address("releaser", releaser or signer.public_key)
        if refund_after is not None:
            _require_int("refund_after", refund_after, 1)
            if refund_after <= int(time.time()):
                raise ValueError("refund_after must be in the future")
        if refund_to is not None:
            _require_address("refund_to", refund_to)

        args: List[xdr.SCVal] = [
            scval.to_address(signer.public_key),
            scval.to_address(payee),
            scval.to_address(token),
            scval.to_int128(amount),
            scval.to_string(condition_ref),
            scval.to_address(releaser_address),
            scval.to_uint64(refund_after) if refund_after is not None else scval.to_void(),
            scval.to_bool(notify_payee),
            scval.to_address(refund_to) if refund_to is not None else scval.to_void(),
        ]
        tx_hash, response = self._invoke("create_escrow", args, signer)
        created = self._return_value(response)
        return EscrowCreated(
            escrow_id=None if created is None else int(created),
            tx_hash=tx_hash,
        )

    def release(self, escrow_id: int, *, caller: Optional[Keypair] = None) -> str:
        """Moves the escrow's funds to its payee; returns the transaction hash."""
        _require_int("escrow_id", escrow_id, 1)
        signer = self._signer_for(caller)
        tx_hash, _ = self._invoke(
            "release",
            [scval.to_uint64(escrow_id), scval.to_address(signer.public_key)],
            signer,
        )
        return tx_hash

    def refund(self, escrow_id: int, *, caller: Optional[Keypair] = None) -> str:
        """Returns the escrow's funds to its refund destination; returns the hash."""
        _require_int("escrow_id", escrow_id, 1)
        signer = self._signer_for(caller)
        tx_hash, _ = self._invoke(
            "refund",
            [scval.to_uint64(escrow_id), scval.to_address(signer.public_key)],
            signer,
        )
        return tx_hash


__all__ = [
    "EscrowClient",
    "EscrowStatus",
    "EscrowInfo",
    "EscrowCreated",
    "TESTNET_RPC_URL",
    "TESTNET_NETWORK_PASSPHRASE",
    "MAX_CONDITION_REF_LENGTH",
    "MAX_RELEASERS",
    "EscrowError",
]
