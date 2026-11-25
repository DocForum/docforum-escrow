# docforum-escrow Python SDK

Python client for the `docforum-escrow` Soroban contract. It mirrors the
TypeScript SDK's core surface (`create_escrow`, `get_status`, `get_escrow`,
`release`, `refund`) with typed contract errors and plain `int` i128 amounts,
on top of the Stellar Python SDK (`stellar-sdk`).

> **Testnet/local only.** The client refuses the Stellar public network
> passphrase. Mainnet use is blocked until the security review in `ROADMAP.md`
> Phase E4 is complete. There is no PHI or domain-specific payload anywhere in
> this package: amounts and parties are generic, and `condition_ref` is an
> opaque id that is public on-chain forever.

- Distribution name: `docforum-escrow` (not on PyPI yet, see [Publishing](#publishing))
- Import name: `docforum_escrow`
- Python: 3.10+
- Depends on: `stellar-sdk >=17,<18`

## Install

From a checkout, until the first release:

```bash
pip install ./sdk-python
```

## Quickstart

```python
from stellar_sdk import Keypair
from docforum_escrow import EscrowClient, EscrowStatus, NotFundedError

client = EscrowClient(
    "C...",                                  # deployed escrow contract
    signer=Keypair.from_secret("S..."),      # testnet/local secret key
    # rpc_url defaults to https://soroban-testnet.stellar.org
    # network_passphrase defaults to "Test SDF Network ; September 2015"
)
client.check_network()                       # RPC serves the network you configured

created = client.create_escrow(
    payee="G...",
    token="C...",              # SEP-41 token or native SAC
    amount=10_000_000,         # smallest unit; i128 on-chain, so a plain int
    condition_ref="order-42",  # opaque, <= 64 bytes, public forever
    # releaser=... defaults to the signer
    # refund_after=unix_seconds  optional timeout refund deadline
    # refund_to=..., fee_recipient=..., fee_bps=...  optional
)
print(created.escrow_id, created.tx_hash)

assert client.get_status(created.escrow_id) is EscrowStatus.FUNDED
stored = client.get_escrow(created.escrow_id)
print(stored.amount, stored.releasers, stored.threshold)

client.release(created.escrow_id)            # signer must be a releaser

try:
    client.refund(created.escrow_id)         # only one of release/refund can win
except NotFundedError as err:
    print(err.code, err.contract_error)      # 4 NotFunded
```

Reads (`get_status`, `get_escrow`) work without a signer; they only simulate.

## Public API

```python
EscrowClient(contract_id, *, rpc_url=TESTNET_RPC_URL,
             network_passphrase=TESTNET_PASSPHRASE, signer=None, server=None,
             base_fee=100, tx_timeout=300, poll_attempts=60)

client.check_network() -> None
client.create_escrow(*, payee, token, amount, condition_ref, releaser=None,
                     payer=None, refund_after=None, notify_payee=False,
                     refund_to=None, fee_recipient=None, fee_bps=None)
    -> CreateEscrowResult(escrow_id, tx_hash, ledger)
client.get_status(escrow_id) -> EscrowStatus
client.get_escrow(escrow_id) -> Escrow
client.release(escrow_id, *, caller=None) -> TxResult(tx_hash, ledger)
client.refund(escrow_id, *, caller=None) -> TxResult(tx_hash, ledger)

# Single-party amendments: the signer is the acting party.
client.create_escrow_with_acceptance(*, payee, token, amount, condition_ref,
                                     releaser=None, payer=None, refund_after=None,
                                     requires_acceptance=True, refund_to=None)
    -> CreateEscrowResult(escrow_id, tx_hash, ledger)
client.accept(escrow_id, *, payee=None) -> TxResult             # signer = payee
client.cancel(escrow_id, *, payer=None) -> TxResult             # signer = payer
client.top_up(escrow_id, amount, *, payer=None) -> TxResult     # signer = payer
client.transfer_payee(escrow_id, new_payee, *, current_payee=None)
    -> TxResult                                                 # signer = current payee
```

Each write is authorized by exactly one party, the signer. The actor
arguments (`payer=`, `payee=`, `current_payee=`, `caller=`) default to the
signer; naming anyone else raises `InvalidArgumentError` before any request.
`cancel` only works while the escrow is `Funded`, was created with the
acceptance gate and hasn't been accepted (docs/adr/0010). `top_up` is rejected
on pooled and streamed escrows (`NotSupportedForPooledError`,
`StreamTopUpUnsupportedError`) and while the contract is paused
(`PausedError`). `transfer_payee` refuses the contract's own address as
`new_payee` client-side (`InvalidNewPayee` on-chain). `extend_refund_after`
and `rotate_releaser` need two signatures, which this client can't produce,
so they aren't wrapped.

Argument order and types follow `contract-spec.json`; an offline test fails if
the client and the spec disagree.

`EscrowStatus` is a `str` enum: `FUNDED`, `RELEASED`, `REFUNDED`, `CANCELLED`.
`Escrow` is a frozen dataclass with the contract's `EscrowData` fields
(`payer`, `payee`, `token`, `amount`, `condition_ref`, `status`, `releasers`,
`threshold`, `refund_after`, `notify_payee`, `payees`, `requires_acceptance`,
`accepted_at`, `refund_to`, `release_not_before`, `fee_recipient`,
`fee_bps`). Fields an older deployment lacks are `None`; fields this SDK does
not know yet land, decoded, in `Escrow.extra`.

### Amounts (i128)

Every amount is a Python `int`. Python ints are unbounded, so the client
checks the i128 range (`-(2**127)` to `2**127 - 1`) and that amounts are
positive before sending anything. `bool` and `float` are rejected. Never
round-trip an amount through `float`.

## Errors

Every error derives from `EscrowError`. Contract failures are `ContractError`
subclasses with the contract's `code` and `contract_error` name, one class per
code in the contract's `Error` enum, named like the TypeScript SDK's:

```python
from docforum_escrow import ContractError, NotFoundError, UnauthorizedError

try:
    client.get_escrow(999)
except NotFoundError:          # code 1
    ...
except ContractError as err:   # any other contract code
    print(err.code, err.contract_error)
```

Two names differ from `<Name>Error`: `InvalidAmountContractError` (code 2,
as in the TS SDK) and `OverflowContractError` (code 12; `OverflowError` is a
Python builtin). A code this SDK does not know yet is raised as a plain
`ContractError` with that code and `contract_error == "UnknownContractError"`.
The code map is checked offline against `contract-spec.json`,
`contracts/escrow/src/errors.rs` and the TypeScript SDK's generated map.

Codes are recovered from simulation errors (`HostError: Error(Contract, #n)`)
before any fee is spent, and from the diagnostic events of a transaction that
failed after submission. Non-contract failures:

| Error | Meaning |
|---|---|
| `InvalidArgumentError` | client-side validation failed; nothing was sent (also a `ValueError`) |
| `SignerRequiredError` | a write was called on a client without `signer` |
| `NetworkMismatchError` | public network passphrase, or the RPC serves another network |
| `UnsupportedAuthorizationError` | simulation wants a signature from someone other than the signer (e.g. `notify_payee=True` with another payee) |
| `SimulationFailure` | simulation failed without a contract code |
| `SubmissionFailure` | the transaction was sent but failed without a contract code |
| `RequestTimeoutError` | the transaction was not final after `poll_attempts` |

`to_escrow_error(exc)` applies the same classification as the TypeScript
SDK's `toEscrowError` to any exception or message.

## Signing and authorization

The signer pays the fee and is the `payer` for `create_escrow` and the
`caller` for `release` / `refund`. Its own authorization comes back from
simulation as source-account credentials, which the envelope signature
covers. Passing a `payer` or `caller` other than the signer raises
`InvalidArgumentError`, and any simulation that needs another address's
signature raises `UnsupportedAuthorizationError` before anything is signed.

## Transaction flow

Each write loads the signer's account, builds an `InvokeHostFunction`
transaction, runs `prepare_transaction` (simulation, footprint, resource fee
and auth), signs, sends, and polls `getTransaction` until the transaction is
final. The return value (the new escrow id for `create_escrow`) is decoded
from the transaction meta. Reads only simulate.

## Tests

### Offline unit tests

```bash
cd sdk-python
pip install -e ".[dev]"
ruff check . && ruff format --check .
mypy
pytest
```

Fully offline: a fake RPC server stands in for the network. They cover i128
boundaries and argument validation, `EscrowData` / `EscrowStatus` decoding,
the arguments each call sends against `contract-spec.json`, the error map
against the contract and the TS SDK, contract-error recovery from simulation
and from failed-transaction diagnostic events, foreign-auth refusal, and the
public-network refusal. CI runs them in `.github/workflows/sdk-python.yml`.

### Integration tests

Kept out of the default run and out of CI, the same policy as the TypeScript
SDK's testnet suite: they depend on testnet liveness and Friendbot's rate
limits.

```bash
cd sdk-python
ESCROW_INTEGRATION=1 pytest -m integration -v
```

By default they target the newest testnet deployment in `deployments.json`
with the native XLM SAC, and generate and Friendbot-fund fresh payer and
payee keypairs on every run, so no secret key is needed or committed.

| Variable | Meaning |
|---|---|
| `ESCROW_INTEGRATION` | must be `1`; otherwise the tests skip |
| `ESCROW_CONTRACT_ID` | optional; another deployed escrow contract |
| `ESCROW_TOKEN_ID` | optional; an allowed SEP-41 token (default: native XLM SAC) |
| `STELLAR_RPC_URL` | optional; defaults to testnet (quickstart: `http://localhost:8000/rpc`) |
| `STELLAR_NETWORK_PASSPHRASE` | optional; defaults to testnet |
| `FRIENDBOT_URL` | optional; defaults to `https://friendbot.stellar.org` |

They cover create → `get_status` → `get_escrow` (every core field checked)
→ `release`, then a refund that must fail with `NotFundedError`; create →
`refund`, then a release that must fail; reads from a client with no signer;
and an unknown id → `NotFoundError`.

## Publishing

Not published. The plan, for review before anything is uploaded:

1. Versioning follows strict semver, `0.x` while the contract is
   testnet-only; a breaking API change bumps the minor version.
2. Releases are tagged `sdk-python-vX.Y.Z`. A workflow builds the sdist and
   wheel (`python -m build`) and publishes with PyPI trusted publishing
   (OIDC, no stored token) from a protected `pypi` environment.
3. The PyPI project name `docforum-escrow` and the trusted publisher are a
   one-time human setup by a maintainer, like the npm org for the TS SDK.

Until then, install from a checkout or a Git URL.
