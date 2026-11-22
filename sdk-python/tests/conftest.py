"""Offline test doubles. Nothing here touches the network."""

from __future__ import annotations

from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest
from stellar_sdk import Account, Keypair, scval, xdr
from stellar_sdk.exceptions import PrepareTransactionException
from stellar_sdk.soroban_rpc import (
    GetTransactionStatus,
    SendTransactionStatus,
    SimulateTransactionResponse,
)

CONTRACT_ID = "CDX2JEMA5SO7GZVXDNGDDB35GPV43J7BUTYYH77ALAT72S65GOW5KNEO"
TOKEN_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"


def meta_with_return(value: xdr.SCVal) -> str:
    empty = xdr.LedgerEntryChanges([])
    meta = xdr.TransactionMeta(
        v=4,
        v4=xdr.TransactionMetaV4(
            ext=xdr.ExtensionPoint(0),
            tx_changes_before=empty,
            operations=[],
            tx_changes_after=empty,
            soroban_meta=xdr.SorobanTransactionMetaV2(
                ext=xdr.SorobanTransactionMetaExt(0), return_value=value
            ),
            events=[],
            diagnostic_events=[],
        ),
    )
    return meta.to_xdr()


def contract_error_event(code: int) -> str:
    error = xdr.SCVal(
        xdr.SCValType.SCV_ERROR,
        error=xdr.SCError(xdr.SCErrorType.SCE_CONTRACT, contract_code=xdr.Uint32(code)),
    )
    event = xdr.DiagnosticEvent(
        in_successful_contract_call=False,
        event=xdr.ContractEvent(
            ext=xdr.ExtensionPoint(0),
            contract_id=None,
            type=xdr.ContractEventType.DIAGNOSTIC,
            body=xdr.ContractEventBody(
                0,
                v0=xdr.ContractEventV0(
                    topics=[scval.to_symbol("error"), error], data=scval.to_string("failing")
                ),
            ),
        ),
    )
    return event.to_xdr()


@dataclass
class FakeServer:
    """Records calls and answers with canned responses."""

    read_result: xdr.SCVal | None = None
    read_error: str | None = None
    prepare_error: str | None = None
    send_status: SendTransactionStatus = SendTransactionStatus.PENDING
    send_events: list[str] = field(default_factory=list)
    final_status: GetTransactionStatus = GetTransactionStatus.SUCCESS
    return_value: xdr.SCVal = field(default_factory=scval.to_void)
    failed_events: list[str] = field(default_factory=list)
    add_auth: Any = None
    passphrase: str = "Test SDF Network ; September 2015"
    calls: list[tuple[str, Any]] = field(default_factory=list)

    def get_network(self) -> Any:
        return SimpleNamespace(passphrase=self.passphrase)

    def simulate_transaction(self, tx: Any) -> Any:
        self.calls.append(("simulate", tx))
        results = None
        if self.read_result is not None:
            results = [SimpleNamespace(xdr=self.read_result.to_xdr())]
        return SimpleNamespace(error=self.read_error, results=results)

    def load_account(self, account_id: str) -> Account:
        self.calls.append(("load_account", account_id))
        return Account(account_id, 41)

    def prepare_transaction(self, tx: Any) -> Any:
        self.calls.append(("prepare", tx))
        if self.prepare_error is not None:
            response = SimulateTransactionResponse.model_validate(
                {"error": self.prepare_error, "latestLedger": 1}
            )
            raise PrepareTransactionException("simulation failed", response)
        if self.add_auth is not None:
            tx.transaction.operations[0].auth = [self.add_auth]
        return tx

    def send_transaction(self, tx: Any) -> Any:
        self.calls.append(("send", tx))
        return SimpleNamespace(
            status=self.send_status,
            hash="ab" * 32,
            diagnostic_events_xdr=self.send_events or None,
            error_result_xdr=None,
        )

    def poll_transaction(self, tx_hash: str, max_attempts: int = 30) -> Any:
        self.calls.append(("poll", tx_hash))
        ok = self.final_status == GetTransactionStatus.SUCCESS
        return SimpleNamespace(
            status=self.final_status,
            transaction_hash=tx_hash,
            ledger=123,
            result_meta_xdr=meta_with_return(self.return_value) if ok else None,
            diagnostic_events_xdr=self.failed_events or None,
        )


@pytest.fixture
def keypair() -> Keypair:
    return Keypair.random()
