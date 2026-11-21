---
file: README.md
section: Verify this deployment
---
### Python client

[`sdk-python/`](sdk-python) mirrors the TypeScript surface (`create_escrow`,
`get_status`, `get_escrow`, `release`, `refund`) on the Stellar Python SDK,
with typed contract errors and plain `int` i128 amounts. Testnet only, not
on PyPI yet. See [`sdk-python/README.md`](sdk-python/README.md).
