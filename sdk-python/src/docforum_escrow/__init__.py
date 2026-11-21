"""Python client for the docforum-escrow Soroban contract (testnet only).

>>> from stellar_sdk import Keypair
>>> from docforum_escrow import EscrowClient
>>> client = EscrowClient("C...", signer=Keypair.from_secret("S..."))  # doctest: +SKIP
>>> created = client.create_escrow(payee="G...", token="C...", amount=10_000_000,
...                                condition_ref="order-42")  # doctest: +SKIP
>>> client.get_status(created.escrow_id)  # doctest: +SKIP
<EscrowStatus.FUNDED: 'Funded'>
"""

from .client import TESTNET_PASSPHRASE, TESTNET_RPC_URL, EscrowClient
from .errors import *  # noqa: F403 - the error classes are part of the public API
from .errors import __all__ as _errors_all
from .types import CreateEscrowResult, Escrow, EscrowStatus, PayeeShare, TxResult

__version__ = "0.1.0"

__all__ = [
    "EscrowClient",
    "TESTNET_RPC_URL",
    "TESTNET_PASSPHRASE",
    "CreateEscrowResult",
    "Escrow",
    "EscrowStatus",
    "PayeeShare",
    "TxResult",
    "__version__",
    *_errors_all,
]
