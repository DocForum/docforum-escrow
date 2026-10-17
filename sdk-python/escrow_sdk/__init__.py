"""Python client SDK for the escrow Soroban contract.

This module exposes the same surface as the TypeScript SGK in ``sdk/```:

```python
from escrow_sdk import EscrowClient

client = EscrowClient(
    contract_id="CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    recipient="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    amount=100000000,
    deadline=1700000000,
    secret_key="S" + "0" * 55,
)
escrow_id = client.create_escrow()
status = client.get_status(escrow_id)
```

All amounts are integers (i128). Network calls target Stellar testnet by default.
"""

from ._client import EscrowClient, EscrowStatus, EscrowInfo
from ._errors import (
    EscrowError,
    EscrowErrorCode,
    error_from_code,
)

__all__ = [
    "EscrowClient",
    "EscrowStatus",
    "EscrowInfo",
    "EscrowError",
    "EscrowErrorCode",
    "error_from_code",
]

__version__ = "0.1.0"
