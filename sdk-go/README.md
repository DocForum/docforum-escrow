# docforum-escrow Go SDK

Go client for the `docforum-escrow` Soroban contract. It wraps the contract's
create/read/settle surface with idiomatic Go types, typed contract errors, and
an explicit `Signer` abstraction.

> **Testnet/local only.** This SDK deliberately rejects the Stellar public
> network passphrase. Mainnet use is blocked until the security-review
> milestone in `ROADMAP.md` Phase E4 is complete. There is no PHI or
> domain-specific payload in this module — amounts and parties are generic.

- Module path: `github.com/DocForum/docforum-escrow/sdk-go`
- Package name: `escrow`
- Go: 1.25+ (required by `go-stellar-sdk` v0.7.3, as declared in `go.mod`)
- Contract dependency: `github.com/stellar/go-stellar-sdk` v0.7.3

## Install

```bash
go get github.com/DocForum/docforum-escrow/sdk-go@latest
```

Until the first `sdk-go/v*` tag is published, use `@main` (or a commit) and
`replace` if you consume the repository directly.

## Quickstart

```go
package main

import (
    "context"
    "errors"
    "fmt"
    "math/big"

    escrow "github.com/DocForum/docforum-escrow/sdk-go"
    "github.com/stellar/go-stellar-sdk/network"
)

func main() {
    ctx := context.Background()

    signer, err := escrow.NewKeypairSigner(
        "S...", // testnet/local secret key
        network.TestNetworkPassphrase,
    )
    if err != nil {
        panic(err)
    }

    client, err := escrow.New(escrow.Config{
        RPCURL:            "https://soroban-testnet.stellar.org",
        ContractID:        "C...", // deployed escrow contract
        NetworkPassphrase: network.TestNetworkPassphrase,
        Signer:            signer,
    })
    if err != nil {
        panic(err)
    }
    defer client.Close()

    amount := big.NewInt(10_000_000) // 1 XLM in stroops; i128 on-chain
    created, err := client.CreateEscrow(ctx, escrow.CreateEscrowParams{
        // Payer is optional and defaults to signer.Address(). If set, it must
        // be the signer: this client signs the payer authorization itself.
        Payer:        signer.Address(),
        Payee:        "G...",
        Token:        "C...", // SEP-41 token / native SAC
        Amount:       amount,
        ConditionRef: "invoice-42", // opaque, <= 64 bytes
        Releaser:     signer.Address(),
        // RefundAfter: &unixSeconds, // optional timeout refund deadline
        // NotifyPayee: true,         // requires payee auth; see limitations
    })
    if err != nil {
        panic(err)
    }
    fmt.Println("escrow", created.EscrowID, "tx", created.TxHash)

    status, err := client.GetStatus(ctx, created.EscrowID)
    if err != nil {
        panic(err)
    }
    fmt.Println("status:", status) // Funded | Released | Refunded

    stored, err := client.GetEscrow(ctx, created.EscrowID)
    if err != nil {
        panic(err)
    }
    fmt.Println("amount:", stored.Amount, "releasers:", stored.Releasers)

    // Release signs with the configured signer, which must be a releaser.
    if _, err := client.Release(ctx, created.EscrowID); err != nil {
        panic(err)
    }

    // Refund instead of release (only one of the two can succeed):
    // if _, err := client.Refund(ctx, created.EscrowID); err != nil { ... }
}
```

### Configuration defaults

| Field | Default |
|---|---|
| `RPCURL` | `https://soroban-testnet.stellar.org` |
| `NetworkPassphrase` | `Test SDF Network ; September 2015` |
| `HTTPClient` | `&http.Client{Timeout: 30s}` |
| `PollTimeout` | `60s` |
| `PollInterval` | `500ms` |
| `Signer` | none (constructor succeeds; RPC calls return `ErrSignerRequired`) |

`New` rejects the public-network passphrase with `ErrNetworkMismatch`.
`client.CheckNetwork(ctx)` additionally checks the RPC server's passphrase
against the configured one. Local quickstart networks use
`Standalone Network ; February 2017` and `http://localhost:8000/rpc`.

## Public API

```go
type Signer interface {
    Address() string
    SignTransaction(ctx context.Context, envelopeXDR string) (string, error)
}
func NewKeypairSigner(secret, networkPassphrase string) (*KeypairSigner, error)
func NewKeypairSignerFromKeypair(kp *keypair.Full, networkPassphrase string) *KeypairSigner

func New(Config) (*Client, error)
func (*Client) CheckNetwork(ctx context.Context) error
func (*Client) ContractID() string

func (*Client) CreateEscrow(ctx context.Context, CreateEscrowParams) (CreateEscrowResult, error)
func (*Client) CreateEscrowWithReleasers(ctx context.Context, CreateEscrowWithReleasersParams) (CreateEscrowResult, error)
func (*Client) GetStatus(ctx context.Context, escrowID uint64) (EscrowStatus, error)
func (*Client) GetEscrow(ctx context.Context, escrowID uint64) (Escrow, error)
func (*Client) Release(ctx context.Context, escrowID uint64) (TxResult, error)
func (*Client) Refund(ctx context.Context, escrowID uint64) (TxResult, error)
func (*Client) TopUp(ctx context.Context, escrowID uint64, amount *big.Int) (TxResult, error)
func (*Client) ReleaseWithApprovals(ctx context.Context, escrowID uint64, approvers []Signer) (TxResult, error)
func (*Client) RefundWithApprovals(ctx context.Context, escrowID uint64, approvers []Signer) (TxResult, error)
```

`EscrowStatus` is a typed enum: `EscrowStatusFunded` (0),
`EscrowStatusReleased` (1), `EscrowStatusRefunded` (2), with `String()` and
`IsValid()`.

`Escrow.Amount` is a `*big.Int` because the contract stores an `i128`. The same
is true for every amount parameter, including `TopUp` and create calls. Do not
convert these to `int64`: testnet balances fit, but the contract type does not,
and an i128 can exceed `int64` by design.

`Escrow` exposes the current contract's full record: `Payer`, `Payee`, `Token`,
`Amount`, `ConditionRef`, `Releasers`, `Threshold`, `RefundAfter`,
`NotifyPayee`, `Status`, plus `RequiresAcceptance` and `AcceptedAt` when the
deployment has those fields.

## Error handling

Contract errors are `*ContractError` values with the contract's numeric code
and name. Every code the contract defines has a sentinel:

```go
if errors.Is(err, escrow.ErrNotFound) { /* code 1 */ }
if errors.Is(err, escrow.ErrUnauthorized) { /* code 3 */ }
if errors.Is(err, escrow.ErrNotFunded) { /* code 4 */ }
if errors.Is(err, escrow.ErrThresholdNotMet) { /* code 15 */ }

var contractErr *escrow.ContractError
if errors.As(err, &contractErr) {
    fmt.Println(contractErr.Code, contractErr.Name)
}
```

Codes map to the contract's `Error` enum: 1 `NotFound`, 2 `InvalidAmount`,
3 `Unauthorized`, 4 `NotFunded`, 5 `InvalidRefundAfter`, 6 `BalanceMismatch`,
7 `ConditionRefTooLong`, 8 `DisallowedToken`, 9 `CallbackFailed`,
12 `Overflow`, 13 `InvalidThreshold`, 14 `TooManyReleasers`,
15 `ThresholdNotMet`, 16 `DuplicateApprover`, 17 `DuplicateReleaser`,
18 `AcceptanceRequired`, 19 `AcceptanceNotConfigured`, 20 `AlreadyAccepted`.
Codes 10 and 11 are not defined by the contract. Unknown/newer codes are kept
as `ContractError{Code: n, Name: "UnknownContractError"}`.

Contract codes are recovered from both simulation errors
(`HostError: Error(Contract, #n)`) and failed transaction result/meta
diagnostic events. Non-contract failures use sentinels such as
`ErrInvalidArgument`, `ErrSimulationFailed`, `ErrTransactionFailed`,
`ErrWalletRejected`, `ErrTimeout`, `ErrUnsupportedAuthorization`,
`ErrSignerRequired`, and `ErrNetworkMismatch`.

## Signing and authorization

`KeypairSigner` is the built-in implementation. A custom `Signer` can wrap a
wallet: it receives a base64 transaction envelope and returns a signed
envelope. Single-signer calls rewrite the signer's own Soroban auth entry to
source-account credentials, so the envelope signature is sufficient.

`ReleaseWithApprovals` / `RefundWithApprovals` take a `[]Signer`. The first
signer pays the fee; additional approvers must be `*KeypairSigner` because their
Soroban auth entries are signed locally. Passing the same address twice is
rejected client-side.

`NotifyPayee: true` requires the payee to authorize creation. With a single
configured signer this only works when the payee is that signer; otherwise the
client returns `ErrUnsupportedAuthorization` instead of submitting a
transaction that cannot succeed.

## Transaction flow

Every state-changing call performs the full Soroban flow explicitly:

1. `LoadAccount` for the signer's sequence number.
2. Build `txnbuild.InvokeHostFunction` and simulate with `SimulateTransaction`.
3. Decode `SorobanTransactionData`, apply the resource fee and footprint, and
   carry over the simulation's auth entries.
4. Sign the transaction envelope with the configured `Signer`.
5. `SendTransaction`, then poll with `PollTransactionWithOptions` up to
   `PollTimeout`.
6. Decode the return value from transaction meta (`get_status`/`get_escrow` use
   simulation return values directly).

If simulation reports a contract error, it is returned as `*ContractError`
before any fee is spent.

## Tests

### Offline unit tests

```bash
cd sdk-go
gofmt -l .
go vet ./...
go test ./...
```

These are fully offline and cover ScVal encoding/decoding (addresses, i128,
u64, strings, bools, options, vecs, maps), EscrowData decoding from a
hand-built ScVal map, i128 boundary cases (0, ±1, ±2^64, min/max int128,
out-of-range), transaction-envelope signing, argument validation, and error
code mapping. `go test ./...` does not touch the network.

### Integration tests

`integration_test.go` is behind the `integration` build tag and is skipped
unless `ESCROW_INTEGRATION=1`. It covers:

- create → `get_status` → `get_escrow` → `release`
- create → `refund`
- unknown id → `ErrNotFound` (contract code 1)

Run against testnet or a local quickstart network:

```bash
cd sdk-go
ESCROW_INTEGRATION=1 \
ESCROW_CONTRACT_ID=C... \
ESCROW_TOKEN_ID=C... \
STELLAR_RPC_URL=https://soroban-testnet.stellar.org \
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015" \
STELLAR_SECRET_KEY=S... \
go test -tags=integration -v ./...
```

| Variable | Meaning |
|---|---|
| `ESCROW_INTEGRATION` | must be `1`; otherwise tests skip |
| `ESCROW_CONTRACT_ID` | deployed escrow contract |
| `ESCROW_TOKEN_ID` | SEP-41 token (native SAC is fine) |
| `STELLAR_RPC_URL` | RPC endpoint (quickstart: `http://localhost:8000/rpc`) |
| `STELLAR_NETWORK_PASSPHRASE` | testnet or `Standalone Network ; February 2017` |
| `STELLAR_SECRET_KEY` | secret key used as payer, releaser, and fee source |

The integration tests spend real testnet/local funds (trivially), and the secret
key is read from the environment only. Never commit it.

## CI

`.github/workflows/sdk-go.yml` has two jobs:

- **unit** — `gofmt` check, `go vet ./...`, `go test ./...`; no services, no
  network, always expected to be green.
- **integration** — starts `stellar/quickstart:latest` as a service on local
  mode (RPC at `http://localhost:8000/rpc`), builds the contract WASM with Rust,
  installs the Stellar CLI version pinned in `scripts/stellar-cli-version`,
  deploys a native asset SAC plus the escrow contract, generates and funds an
  identity, and exports the variables above before running
  `go test -tags=integration`.

The integration job is intentionally additive: it is the environment-dependent
job. If quickstart's service-container startup, friendbot funding, or contract
deployment is unavailable in a given runner image, the unit job remains the
authoritative offline gate and the integration job's log identifies which setup
step failed. It has not been claimed as passing here — this repository's local
environment has no Docker daemon or Rust toolchain.

## Versioning

See [`VERSIONING.md`](./VERSIONING.md). In short: the module is `v0.x` while
the contract is testnet-only, breaking Go API changes bump the minor version,
and releases are tagged `sdk-go/vX.Y.Z` (the prefix is required for a Go module
in a subdirectory).
