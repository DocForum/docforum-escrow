"""A thin, synchronous Python client for the ``docforum-escrow`` contract.

It mirrors the TypeScript SDK's core surface (``createEscrow``,
``getStatus``, ``getEscrow``, ``release``, ``refund``) plus the single-party
amendments (``createEscrowWithAcceptance``, ``accept``, ``cancel``,
``topUp``, ``transferPayee``) on top of the Stellar Python SDK's Soroban RPC
client. Every state-changing call runs the full
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
from stellar_sdk.auth import authorize_entry
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
    ThresholdNotMetError,
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
#: ``MAX_RELEASERS`` in ``contracts/escrow/src/constants.rs``.
MAX_RELEASERS = 10
#: Upper bound on the configurable auth-entry lifetime, in ledgers (~17 hours).
MAX_APPROVAL_EXPIRATION_LEDGERS = 1_000


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
    :param approval_expiration_ledgers: how many ledgers past the latest one a
        signed approver auth entry stays valid (1–1000).
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
        approval_expiration_ledgers: int = 100,
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
        if not 1 <= approval_expiration_ledgers <= MAX_APPROVAL_EXPIRATION_LEDGERS:
            raise InvalidArgumentError(
                "approval_expiration_ledgers must be between 1 and "
                f"{MAX_APPROVAL_EXPIRATION_LEDGERS}"
            )
        self.contract_id = contract_id
        self.network_passphrase = network_passphrase
        self.signer = signer
        self.server = server if server is not None else SorobanServer(rpc_url)
        self.base_fee = base_fee
        self.tx_timeout = tx_timeout
        self.poll_attempts = poll_attempts
        self.approval_expiration_ledgers = approval_expiration_ledgers

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

    def create_escrow_with_acceptance(
        self,
        *,
        payee: str,
        token: str,
        amount: int,
        condition_ref: str,
        releaser: str | None = None,
        payer: str | None = None,
        refund_after: int | None = None,
        requires_acceptance: bool = True,
        refund_to: str | None = None,
    ) -> CreateEscrowResult:
        """Lock funds in an escrow that waits for the payee's ``accept``.

        Wraps ``create_escrow_with_acceptance`` (docs/adr/0010). Until the payee
        accepts, the payer may :meth:`cancel`, and release is blocked
        (``AcceptanceRequired``). The entry point has no ``notify_payee``, fee or
        release-time arguments. ``payer`` and ``releaser`` default to the
        signer, and ``payer``, if given, must be the signer.
        """
        payer = self._actor("payer", payer)
        releaser = self._require_signer().public_key if releaser is None else releaser
        args = [
            sv.address("payer", payer),
            sv.address("payee", payee),
            sv.address("token", token),
            sv.positive_i128("amount", amount),
            sv.condition_ref(condition_ref),
            sv.address("releaser", releaser),
            sv.option(refund_after, lambda v: sv.u64("refund_after", v)),
            sv.boolean("requires_acceptance", requires_acceptance),
            sv.option(refund_to, lambda v: sv.address("refund_to", v)),
        ]
        response, value = self._invoke("create_escrow_with_acceptance", args)
        return CreateEscrowResult(
            escrow_id=sv.decode_u64(value),
            tx_hash=response.transaction_hash or "",
            ledger=response.ledger,
        )

    def create_escrow_with_releasers(
        self,
        *,
        payee: str,
        token: str,
        amount: int,
        condition_ref: str,
        releasers: Sequence[str],
        threshold: int,
        refund_after: int | None = None,
        notify_payee: bool = False,
        refund_to: str | None = None,
        payer: str | None = None,
    ) -> CreateEscrowResult:
        """Lock funds in an M-of-N releaser quorum escrow (ADR 0007).

        ``releasers`` is 1–10 distinct addresses and ``threshold`` is between 1
        and its length, mirroring ``check_releaser_set`` in the contract; the
        escrow contract's own address is rejected. Settle it with
        :meth:`release_with_approvals` / :meth:`refund_with_approvals`, or let a
        timeout :meth:`refund` run once ``refund_after`` passes.
        """
        payer = self._actor("payer", payer)
        checked, threshold = self._releaser_set(releasers, threshold)
        args = [
            sv.address("payer", payer),
            sv.address("payee", payee),
            sv.address("token", token),
            sv.positive_i128("amount", amount),
            sv.condition_ref(condition_ref),
            sv.address_vec("releasers", checked),
            sv.u32("threshold", threshold),
            sv.option(refund_after, lambda v: sv.u64("refund_after", v)),
            sv.boolean("notify_payee", notify_payee),
            sv.option(refund_to, lambda v: sv.address("refund_to", v)),
        ]
        response, value = self._invoke("create_escrow_with_releasers", args)
        return CreateEscrowResult(
            escrow_id=sv.decode_u64(value),
            tx_hash=response.transaction_hash or "",
            ledger=response.ledger,
        )

    def accept(self, escrow_id: int, *, payee: str | None = None) -> TxResult:
        """Record the payee's acceptance. The signer must be the escrow's payee.

        One-time, only while ``Funded`` and only on an escrow created with the
        acceptance gate (``AcceptanceNotConfigured``, ``AlreadyAccepted``).
        """
        payee = self._actor("payee", payee)
        return self._transact(
            "accept", [sv.u64("escrow_id", escrow_id), sv.address("payee", payee)]
        )

    def cancel(self, escrow_id: int, *, payer: str | None = None) -> TxResult:
        """Withdraw before the payee accepts. The signer must be the escrow's payer.

        Only valid while the escrow is ``Funded``, was created with the
        acceptance gate, and has not been accepted (docs/adr/0010). The funds go
        to ``refund_to`` and the escrow becomes ``Cancelled``.
        """
        payer = self._actor("payer", payer)
        return self._transact(
            "cancel", [sv.u64("escrow_id", escrow_id), sv.address("payer", payer)]
        )

    def top_up(self, escrow_id: int, amount: int, *, payer: str | None = None) -> TxResult:
        """Add ``amount`` to a ``Funded`` escrow. The signer must be the escrow's payer.

        ``amount`` is a positive ``int`` (an ``i128``). Pooled escrows grow through
        contributions instead (``NotSupportedForPooled``), streamed escrows
        can't be topped up (``StreamTopUpUnsupported``), and the call is blocked
        while the contract is paused (``Paused``).
        """
        payer = self._actor("payer", payer)
        return self._transact(
            "top_up",
            [
                sv.u64("escrow_id", escrow_id),
                sv.address("payer", payer),
                sv.positive_i128("amount", amount),
            ],
        )

    def transfer_payee(
        self, escrow_id: int, new_payee: str, *, current_payee: str | None = None
    ) -> TxResult:
        """Reassign future payout rights to ``new_payee``.

        The signer must be the escrow's current payee, and the escrow must be
        ``Funded``. ``new_payee`` may not be this contract (rejected here, and
        by the contract as ``InvalidNewPayee``) or the payer (the contract
        decides that one).
        """
        current_payee = self._actor("current_payee", current_payee)
        if new_payee == self.contract_id:
            raise InvalidArgumentError("new_payee must not be the escrow contract's own address")
        return self._transact(
            "transfer_payee",
            [
                sv.u64("escrow_id", escrow_id),
                sv.address("current_payee", current_payee),
                sv.address("new_payee", new_payee),
            ],
        )

    def release(self, escrow_id: int, *, caller: str | None = None) -> TxResult:
        """Pay the escrow out to its payee. The signer must be a releaser."""
        return self._settle("release", escrow_id, caller)

    def refund(self, escrow_id: int, *, caller: str | None = None) -> TxResult:
        """Return the escrow to its ``refund_to`` address.

        The signer must be a releaser, or anyone once ``refund_after`` passed.
        A timeout refund works on a quorum escrow without approvals.
        """
        return self._settle("refund", escrow_id, caller)

    def release_with_approvals(self, escrow_id: int, approvers: Sequence[Keypair]) -> TxResult:
        """Release a quorum escrow with exactly ``threshold`` distinct approvals.

        ``approvers`` must all be members of the escrow's ``releasers``. Each
        keypair signs its own Soroban auth entry; the configured signer pays the
        fee and signs the envelope. Duplicate, empty, under-threshold and
        non-member lists are rejected before anything is simulated or sent.
        """
        return self._settle_with_approvals("release_with_approvals", escrow_id, approvers)

    def refund_with_approvals(self, escrow_id: int, approvers: Sequence[Keypair]) -> TxResult:
        """Refund a quorum escrow with exactly ``threshold`` distinct approvals.

        Same approver rules as :meth:`release_with_approvals`. Refund never pays
        the protocol fee, and the timeout :meth:`refund` path stays available.
        """
        return self._settle_with_approvals("refund_with_approvals", escrow_id, approvers)

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

    def _actor(self, name: str, value: str | None) -> str:
        """The acting party's address: the signer, or an explicit match for it.

        This client signs as exactly one party, so naming anyone else raises
        before any request is made.
        """
        signer = self._require_signer()
        if value is None:
            return signer.public_key
        if value != signer.public_key:
            raise InvalidArgumentError(f"{name} must be the signer's address")
        return value

    def _transact(
        self,
        function: str,
        args: Sequence[xdr.SCVal],
        extra_signers: Sequence[Keypair] = (),
    ) -> TxResult:
        response, _ = self._invoke(function, args, extra_signers)
        return TxResult(tx_hash=response.transaction_hash or "", ledger=response.ledger)

    def _settle(self, function: str, escrow_id: int, caller: str | None) -> TxResult:
        caller = self._actor("caller", caller)
        return self._transact(
            function, [sv.u64("escrow_id", escrow_id), sv.address("caller", caller)]
        )

    def _settle_with_approvals(
        self, function: str, escrow_id: int, approvers: Sequence[Keypair]
    ) -> TxResult:
        self._require_signer()
        keys = self._approver_keypairs(approvers)
        escrow = self.get_escrow(escrow_id)
        if len(keys) < escrow.threshold:
            raise ThresholdNotMetError(
                f"{function}: {len(keys)} approvers supplied, but escrow {escrow_id} "
                f"needs {escrow.threshold} (ThresholdNotMet)"
            )
        for keypair in keys:
            if keypair.public_key not in escrow.releasers:
                raise InvalidArgumentError(
                    f"{keypair.public_key} is not a releaser of escrow {escrow_id}"
                )
        return self._transact(
            function,
            [
                sv.u64("escrow_id", escrow_id),
                sv.address_vec("approvers", [keypair.public_key for keypair in keys]),
            ],
            extra_signers=keys,
        )

    def _approver_keypairs(self, approvers: Sequence[Keypair]) -> list[Keypair]:
        if isinstance(approvers, (str, bytes)) or not isinstance(approvers, Sequence):
            raise InvalidArgumentError("approvers must be a sequence of Keypair objects")
        if not approvers:
            raise InvalidArgumentError("approvers must not be empty")
        keys: list[Keypair] = []
        seen: set[str] = set()
        for keypair in approvers:
            if not isinstance(keypair, Keypair) or keypair.signing_key is None:
                raise InvalidArgumentError("approvers must be Keypair objects with a secret key")
            if keypair.public_key in seen:
                raise InvalidArgumentError(f"duplicate approver: {keypair.public_key}")
            seen.add(keypair.public_key)
            keys.append(keypair)
        return keys

    def _releaser_set(self, releasers: Sequence[str], threshold: int) -> tuple[list[str], int]:
        """The client-side half of the contract's ``check_releaser_set``."""
        if isinstance(releasers, (str, bytes)) or not isinstance(releasers, Sequence):
            raise InvalidArgumentError("releasers must be a sequence of strkeys")
        if not 1 <= len(releasers) <= MAX_RELEASERS:
            raise InvalidArgumentError(
                f"releasers must contain between 1 and {MAX_RELEASERS} addresses"
            )
        checked: list[str] = []
        for index, value in enumerate(releasers):
            sv.address(f"releasers[{index}]", value)
            if value == self.contract_id:
                raise InvalidArgumentError(
                    "releasers must not include the escrow contract's own address"
                )
            if value in checked:
                raise InvalidArgumentError(f"releasers contains a duplicate: {value}")
            checked.append(value)
        if isinstance(threshold, bool) or not isinstance(threshold, int):
            raise InvalidArgumentError("threshold must be an int")
        if not 1 <= threshold <= len(checked):
            raise InvalidArgumentError("threshold must be between 1 and the number of releasers")
        return checked, threshold

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
        self,
        function: str,
        args: Sequence[xdr.SCVal],
        extra_signers: Sequence[Keypair] = (),
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

        self._sign_auth_entries(function, prepared, signer, extra_signers)

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

    def _sign_auth_entries(
        self,
        function: str,
        envelope: TransactionEnvelope,
        signer: Keypair,
        extra_signers: Sequence[Keypair],
    ) -> None:
        """Sign each address-credential auth entry, or refuse before sending.

        The envelope signer's own entry is rewritten to source-account
        credentials (the envelope signature satisfies it), so no key signs
        twice. Every other entry must belong to one of ``extra_signers``; an
        entry for an address this client has no key for fails closed before the
        envelope is signed or sent. As in the Go SDK, entries are signed after
        the one simulation that set the footprint and resource fee; signing an
        entry does not change either.
        """
        keypairs = {keypair.public_key: keypair for keypair in (signer, *extra_signers)}
        pending: list[tuple[xdr.SorobanAuthorizationEntry, Keypair]] = []
        for op in envelope.transaction.operations:
            entries = getattr(op, "auth", None) or []
            for index, entry in enumerate(entries):
                creds = entry.credentials
                if creds.type == xdr.SorobanCredentialsType.SOROBAN_CREDENTIALS_SOURCE_ACCOUNT:
                    continue
                address = _credential_address(creds)
                if address is None:
                    raise UnsupportedAuthorizationError(
                        f"{function}: unsupported authorization credentials {creds.type}"
                    )
                if address == signer.public_key:
                    entries[index] = xdr.SorobanAuthorizationEntry(
                        credentials=xdr.SorobanCredentials(
                            xdr.SorobanCredentialsType.SOROBAN_CREDENTIALS_SOURCE_ACCOUNT
                        ),
                        root_invocation=entry.root_invocation,
                    )
                    continue
                keypair = keypairs.get(address)
                if keypair is None:
                    raise UnsupportedAuthorizationError(
                        f"{function} needs a separate authorization from {address}, "
                        "which this client has no key for"
                    )
                pending.append((entry, keypair))

        if not pending:
            return
        try:
            latest = self.server.get_latest_ledger().sequence
        except (BaseRequestError, SdkError) as exc:
            raise to_escrow_error(exc) from exc
        expiration = latest + self.approval_expiration_ledgers
        for entry, keypair in pending:
            entry.credentials = authorize_entry(
                entry, keypair, expiration, self.network_passphrase
            ).credentials


def _credential_address(creds: xdr.SorobanCredentials) -> str | None:
    """The address of an address-credential auth entry, if it has one."""
    for attr in ("address", "address_v2", "address_with_delegates"):
        inner = getattr(creds, attr, None)
        if inner is not None:
            target = getattr(inner, "address", None) or getattr(
                getattr(inner, "address_credentials", None), "address", None
            )
            return Address.from_xdr_sc_address(target).address if target is not None else None
    return None


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
