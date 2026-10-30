"""Python client SDK for the escrow Soroban contract.

This module exposes the same surface as the TypeScript SDK in ``sdk/``:

```python
from escrow_sdk import EscrowClient

client = EscrowClient(
    "CAFI5QOTNLK5OIHEHGGQ7B22RN5IUOFGKKEID2OQCZSCJAQS4FLSS2DR",
    secret_key=os.environ["STELLAR_SECRET_KEY"],
)

status = client.get_status(1)              # EscrowStatus.REFUNDED
info = client.get_escrow(1)               # EscrowInfo
created = client.create_escrow(
    payee="G...",
    token="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    amount=10_000_000,
    condition_ref="invoice-42",
    releaser="G...",
)
created.escrow_id, created.tx_hash
```

All amounts are integers (i128) in the token's smallest unit. Reads are
simulated against Soroban RPC and need no keypair; network defaults are
Stellar testnet only (hard rule 4). Contract failures raise ``EscrowError``
with the contract's numeric code and symbol name.
"""

from ._client import (
    MAX_CONDITION_REF_LENGTH,
    MAX_RELEASERS,
    MAX_AMOUNT,
    TESTNET_NETWORK_PASSPHRASE,
    TESTNET_RPC_URL,
    EscrowClient,
    EscrowCreated,
    EscrowInfo,
    EscrowStatus,
)
from ._errors import (
    ERROR_MESSAGES,
    EscrowError,
    EscrowErrorCode,
    error_from_code,
    error_from_message,
)

__all__ = [
    "EscrowClient",
    "EscrowCreated",
    "EscrowStatus",
    "EscrowInfo",
    "EscrowError",
    "EscrowErrorCode",
    "ERROR_MESSAGES",
    "error_from_code",
    "error_from_message",
    "MAX_AMOUNT",
    "MAX_CONDITION_REF_LENGTH",
    "MAX_RELEASERS",
    "TESTNET_NETWORK_PASSPHRASE",
    "TESTNET_RPC_URL",
]

__version__ = "0.1.0"
