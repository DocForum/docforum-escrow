"""Live testnet integration tests. Kept out of default runs and CI.

Same policy as the TypeScript SDK's ``sdk/tests/testnet-integration.test.ts``:
it depends on testnet liveness and Friendbot's rate limits, so it never gates
a PR. Run it with::

    cd sdk-python
    ESCROW_INTEGRATION=1 pytest -m integration -v

By default it targets the newest testnet deployment in ``deployments.json``
with the native XLM SAC, and generates and Friendbot-funds fresh payer and
payee keypairs, so no secret is needed or ever committed. Overrides:
``ESCROW_CONTRACT_ID``, ``ESCROW_TOKEN_ID``, ``STELLAR_RPC_URL``,
``STELLAR_NETWORK_PASSPHRASE``, ``FRIENDBOT_URL`` (all optional).
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import pytest
from stellar_sdk import Keypair

import docforum_escrow as escrow
from docforum_escrow import TESTNET_PASSPHRASE, TESTNET_RPC_URL, EscrowClient, EscrowStatus

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.environ.get("ESCROW_INTEGRATION") != "1", reason="set ESCROW_INTEGRATION=1"
    ),
]

REPO = Path(__file__).resolve().parents[2]
NATIVE_XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
AMOUNT = 1_000


def newest_testnet_contract() -> str:
    deployments = json.loads((REPO / "deployments.json").read_text())["deployments"]
    testnet = [d for d in deployments if d["network"] == "testnet"]
    return str(max(testnet, key=lambda d: d["deployedAt"])["contractId"])


def funded_keypair() -> Keypair:
    """A fresh Friendbot-funded keypair; retries only transient failures."""
    keypair = Keypair.random()
    base = os.environ.get("FRIENDBOT_URL", "https://friendbot.stellar.org")
    url = f"{base}?addr={urllib.parse.quote(keypair.public_key)}"
    request = urllib.request.Request(url, headers={"User-Agent": "docforum-escrow-sdk-python"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=60):
                return keypair
        except urllib.error.HTTPError as exc:
            if exc.code < 500 and exc.code != 429:
                raise RuntimeError(f"Friendbot funding failed: {exc.code}") from exc
        except urllib.error.URLError:
            pass
        time.sleep(2**attempt)
    raise RuntimeError("Friendbot funding failed after retries")


@pytest.fixture(scope="module")
def payer() -> Keypair:
    return funded_keypair()


@pytest.fixture(scope="module")
def payee() -> Keypair:
    # Must exist on-chain: a release to an unfunded account is Undeliverable (36).
    return funded_keypair()


@pytest.fixture(scope="module")
def client(payer: Keypair) -> EscrowClient:
    env = os.environ
    built = EscrowClient(
        env.get("ESCROW_CONTRACT_ID") or newest_testnet_contract(),
        rpc_url=env.get("STELLAR_RPC_URL", TESTNET_RPC_URL),
        network_passphrase=env.get("STELLAR_NETWORK_PASSPHRASE", TESTNET_PASSPHRASE),
        signer=payer,
    )
    built.check_network()
    return built


def create(client: EscrowClient, payee: Keypair, **kwargs: object) -> int:
    return client.create_escrow(
        payee=payee.public_key,
        token=os.environ.get("ESCROW_TOKEN_ID", NATIVE_XLM_SAC),
        amount=AMOUNT,
        condition_ref="sdk-python-it",
        **kwargs,  # type: ignore[arg-type]
    ).escrow_id


def test_create_status_get_release(client: EscrowClient, payer: Keypair, payee: Keypair) -> None:
    deadline = int(time.time()) + 3_600
    escrow_id = create(client, payee, refund_after=deadline)
    assert client.get_status(escrow_id) is EscrowStatus.FUNDED

    stored = client.get_escrow(escrow_id)
    assert stored.payer == payer.public_key
    assert stored.payee == payee.public_key
    assert stored.amount == AMOUNT
    assert stored.condition_ref == "sdk-python-it"
    assert stored.releasers == (payer.public_key,)
    assert stored.threshold == 1
    assert stored.refund_after == deadline

    released = client.release(escrow_id)
    assert len(released.tx_hash) == 64
    assert client.get_status(escrow_id) is EscrowStatus.RELEASED
    with pytest.raises(escrow.NotFundedError):
        client.refund(escrow_id)


def test_create_refund(client: EscrowClient, payee: Keypair) -> None:
    escrow_id = create(client, payee)
    client.refund(escrow_id)
    assert client.get_status(escrow_id) is EscrowStatus.REFUNDED
    with pytest.raises(escrow.NotFundedError):
        client.release(escrow_id)


def test_reads_without_a_signer(client: EscrowClient, payee: Keypair) -> None:
    escrow_id = create(client, payee)
    reader = EscrowClient(
        client.contract_id, network_passphrase=client.network_passphrase, server=client.server
    )
    assert reader.get_status(escrow_id) is EscrowStatus.FUNDED
    assert reader.get_escrow(escrow_id).amount == AMOUNT


def test_unknown_id_is_not_found(client: EscrowClient) -> None:
    with pytest.raises(escrow.NotFoundError):
        client.get_status(2**63)


# ── single-party amendments (issue #471) ──


def payee_client(client: EscrowClient, payee: Keypair) -> EscrowClient:
    """The same contract and RPC, signing as the payee."""
    return EscrowClient(
        client.contract_id,
        network_passphrase=client.network_passphrase,
        server=client.server,
        signer=payee,
    )


def create_with_acceptance(client: EscrowClient, payee: Keypair) -> int:
    return client.create_escrow_with_acceptance(
        payee=payee.public_key,
        token=os.environ.get("ESCROW_TOKEN_ID", NATIVE_XLM_SAC),
        amount=AMOUNT,
        condition_ref="sdk-python-it-accept",
    ).escrow_id


def test_acceptance_accept_release(client: EscrowClient, payer: Keypair, payee: Keypair) -> None:
    escrow_id = create_with_acceptance(client, payee)
    assert client.get_escrow(escrow_id).requires_acceptance is True
    # Release waits for the payee.
    with pytest.raises(escrow.AcceptanceRequiredError):
        client.release(escrow_id)

    payee_client(client, payee).accept(escrow_id)
    assert client.get_escrow(escrow_id).accepted_at is not None
    with pytest.raises(escrow.AlreadyAcceptedError):
        client.cancel(escrow_id)

    client.top_up(escrow_id, AMOUNT)
    assert client.get_escrow(escrow_id).amount == 2 * AMOUNT
    client.release(escrow_id)
    assert client.get_status(escrow_id) is EscrowStatus.RELEASED


def test_acceptance_cancel(client: EscrowClient, payee: Keypair) -> None:
    escrow_id = create_with_acceptance(client, payee)
    client.cancel(escrow_id)
    assert client.get_status(escrow_id) is EscrowStatus.CANCELLED


def test_transfer_payee_then_release(client: EscrowClient, payer: Keypair, payee: Keypair) -> None:
    escrow_id = create(client, payee)
    # The new payee must exist on-chain to receive the release.
    new_payee = funded_keypair()
    payee_client(client, payee).transfer_payee(escrow_id, new_payee.public_key)
    assert client.get_escrow(escrow_id).payee == new_payee.public_key
    client.release(escrow_id)
    assert client.get_status(escrow_id) is EscrowStatus.RELEASED
