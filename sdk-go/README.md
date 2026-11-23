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
func (*Client) CreateEscrowWithReleaseTime(ctx context.Context, CreateEscrowWithReleaseTimeParams) (CreateEscrowResult, error)
func (*Client) CreateEscrowWithAcceptance(ctx context.Context, CreateEscrowWithAcceptanceParams) (CreateEscrowResult, error)
func (*Client) Accept(ctx context.Context, escrowID uint64, payee Signer) (TxResult, error)
func (*Client) Cancel(ctx context.Context, escrowID uint64, payer Signer) (TxResult, error)
func (*Client) TransferPayee(ctx context.Context, escrowID uint64, currentPayee Signer, newPayee string) (TxResult, error)
func (*Client) GetStatus(ctx context.Context, escrowID uint64) (EscrowStatus, error)
func (*Client) GetEscrow(ctx context.Context, escrowID uint64) (Escrow, error)
func (*Client) Release(ctx context.Context, escrowID uint64) (TxResult, error)
func (*Client) Refund(ctx context.Context, escrowID uint64) (TxResult, error)
func (*Client) TopUp(ctx context.Context, escrowID uint64, amount *big.Int) (TxResult, error)
func (*Client) ReleaseWithApprovals(ctx context.Context, escrowID uint64, approvers []Signer) (TxResult, error)
func (*Client) RefundWithApprovals(ctx context.Context, escrowID uint64, approvers []Signer) (TxResult, error)
func (*Client) CreatePooledEscrow(ctx context.Context, CreatePooledEscrowParams) (CreateEscrowResult, error)
func (*Client) Contribute(ctx context.Context, escrowID uint64, payer Signer, amount *big.Int) (TxResult, error)
func (*Client) ClaimRefund(ctx context.Context, escrowID uint64, contributor Signer) (TxResult, error)
func (*Client) GetPooled(ctx context.Context, escrowID uint64) (PooledData, error)
func (*Client) GetContribution(ctx context.Context, escrowID uint64, contributor string) (*Contribution, error)
func (*Client) CreateEscrows(ctx context.Context, CreateEscrowsParams) (CreateEscrowsResult, error)
func (*Client) SettleMany(ctx context.Context, ops []SettleOp) (SettleManyResult, error)

const (
    MaxBatchSize = 16 // contract MAX_BATCH_SIZE (contracts/escrow/src/constants.rs)
    MaxSettleOps = 12 // contract MAX_SETTLE_OPS  (contracts/escrow/src/constants.rs)
)
```

`EscrowStatus` is a typed enum: `EscrowStatusFunded` (0),
`EscrowStatusReleased` (1), `EscrowStatusRefunded` (2),
`EscrowStatusCancelled` (3), with `String()` and `IsValid()`.

`Escrow.Amount` is a `*big.Int` because the contract stores an `i128`. The same
is true for every amount parameter, including `TopUp` and create calls. Do not
convert these to `int64`: testnet balances fit, but the contract type does not,
and an i128 can exceed `int64` by design.

`Escrow` exposes the current contract's full record: `Payer`, `Payee`, `Token`,
`Amount`, `ConditionRef`, `Releasers`, `Threshold`, `RefundAfter`,
`NotifyPayee`, `Status`, plus `RequiresAcceptance` and `AcceptedAt` when the
deployment has those fields.

## Payee acceptance, cancel and payee transfer

An escrow created with `RequiresAcceptance: true` (`create_escrow_with_acceptance`)
sits behind a payee-acceptance gate: `release` fails `ErrAcceptanceRequired`
until the payee accepts, and the payer may take the funds back while the payee
has not accepted.

```go
created, err := client.CreateEscrowWithAcceptance(ctx, escrow.CreateEscrowWithAcceptanceParams{
    Payer:              payer.Address(),
    Payee:              payeeAddress,
    Token:              token,
    Amount:             big.NewInt(10_000_000),
    ConditionRef:       "invoice-42",
    Releaser:           payer.Address(),
    RequiresAcceptance: true,
})

// The payee authorizes accept; the payer can no longer cancel afterwards.
_, err = client.Accept(ctx, created.EscrowID, payeeSigner)

// Or, before the payee accepts: the payer cancels and the funds go back to
// the stored refund destination (status EscrowStatusCancelled).
_, err = client.Cancel(ctx, created.EscrowID, payer)
```

`Accept` and `Cancel` race on one ledger state: whichever lands first wins, and
the loser fails — `ErrAlreadyAccepted` if the payee accepted first, or
`ErrNotFunded` if the payer's cancel settled the escrow first. A settled id
keeps its status entry (ADR 0013), so state-changing entry points answer
`ErrNotFunded` for it; only an id that never existed is `ErrNotFound`. A funded
escrow can still be reassigned by its current payee before it settles — a
wallet rotation, not key-loss recovery:

```go
_, err = client.TransferPayee(ctx, escrowID, currentPayeeSigner, newPayeeAddress)
```

`newPayee` may not be the payer or the contract itself (`ErrInvalidNewPayee`),
and a `notify_payee` escrow has that flag cleared by the transfer so the new
payee does not need the callback hook.

## Pooled escrows

A pooled escrow funds one agreement from many payers (`create_pooled_escrow`,
issue #113, `docs/adr/0011`). Nothing is funded at creation; contributors add
funds until the target is reached, and a round that misses its deadline is
refunded per contributor, pull-based.

```go
deadline := uint64(time.Now().Unix()) + 3600
created, err := client.CreatePooledEscrow(ctx, escrow.CreatePooledEscrowParams{
    Creator:         creator.Address(),
    Payee:           payee,
    Token:           token,
    FundingTarget:   big.NewInt(100_000_000),
    ConditionRef:    "group-order-42",
    Releaser:        creator.Address(),
    FundingDeadline: deadline,
})

// Anyone may contribute before the deadline, up to the target only.
_, err = client.Contribute(ctx, created.EscrowID, aliceSigner, big.NewInt(40_000_000))
_, err = client.Contribute(ctx, created.EscrowID, bobSigner, big.NewInt(50_000_000))

// Fully funded: the releaser releases the pooled total.
_, err = client.Release(ctx, created.EscrowID)

// Or the deadline passes below the target: every contributor pulls their own
// record back, once, in any order.
pooled, err := client.GetPooled(ctx, created.EscrowID) // { FundingTarget, FundingDeadline }
_, err = client.ClaimRefund(ctx, created.EscrowID, aliceSigner)
_, err = client.ClaimRefund(ctx, created.EscrowID, bobSigner)
```

`GetContribution` returns one contributor's `*Contribution` record and is `nil`
when the address never contributed (the contract's `Option<Contribution>`), so
`nil` and a zero contribution stay distinguishable. `GetPooled` fails
`ErrNotPooled` on a non-pooled or unknown id. A failed round still reports
`EscrowStatusFunded` from `GetStatus` — status describes settlement, not funding
— so classify it with `GetEscrow().Amount` plus the deadline (see
`docs/adr/0011`).

## Batch creation and settlement

`CreateEscrows` maps to the contract's atomic `create_escrows` and `SettleMany`
to its best-effort `settle_many` (issue #344, `docs/adr/0012`). Both chunk their
input to the contract's measured limits, which are exported as `MaxBatchSize`
(16) and `MaxSettleOps` (12).

```go
created, err := client.CreateEscrows(ctx, escrow.CreateEscrowsParams{
    Payer: payer.Address(),
    Items: []escrow.CreateItem{
        {Payee: alice, Token: token, Amount: big.NewInt(1_000_000), ConditionRef: "t1", Releaser: payer.Address()},
        {Payee: bob, Token: token, Amount: big.NewInt(2_000_000), ConditionRef: "t2", Releaser: payer.Address()},
    },
})
created.EscrowIDs // input order, across chunks; created.TxHashes has one hash per chunk

settled, err := client.SettleMany(ctx, []escrow.SettleOp{
    {EscrowID: created.EscrowIDs[0], Action: escrow.SettleRelease},
    {EscrowID: created.EscrowIDs[1], Action: escrow.SettleRefund},
})
for _, result := range settled.Results { // one entry per op, input order
    if !result.OK() {
        fmt.Println(result.EscrowID, result.Err) // a *ContractError; the escrow was untouched
    }
}
```

Both batch forms are atomic per transaction but not across chunks. If a later
chunk fails, the returned result holds only the chunks that committed (ids or
per-op results plus their transaction hashes) and the error is that chunk's
failure. `CreateEscrows` validates every item up front so a bad item never
leaves earlier chunks committed. A per-op rejection inside `settle_many` is
reported in `Results`, never as the function's error; the error case is the
transaction-level failure that reverts a whole chunk, such as a failing
`notify_payee` callback (`ErrCallbackFailed`).

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

Every code the contract defines has a name and a sentinel, including the ones
the lifecycle, pooled and batch paths can return:

| Code | Name | Code | Name |
|---:|---|---:|---|
| 1 | `NotFound` | 30 | `RefundNotOpen` |
| 2 | `InvalidAmount` | 31 | `AlreadyRefunded` |
| 3 | `Unauthorized` | 32 | `NoContribution` |
| 4 | `NotFunded` | 33 | `NotSupportedForPooled` |
| 5 | `InvalidRefundAfter` | 34 | `InvalidFundingDeadline` |
| 6 | `BalanceMismatch` | 35 | `InvalidFee` |
| 7 | `ConditionRefTooLong` | 36 | `Undeliverable` |
| 8 | `DisallowedToken` | 37 | `InvalidNewPayee` |
| 9 | `CallbackFailed` | 38 | `Paused` |
| 12 | `Overflow` | 39 | `AlreadyPaused` |
| 13 | `InvalidThreshold` | 40 | `NotPaused` |
| 14 | `TooManyReleasers` | 41 | `InvalidPayeeList` |
| 15 | `ThresholdNotMet` | 42 | `TooManyPayees` |
| 16 | `DuplicateApprover` | 43 | `DuplicatePayee` |
| 17 | `DuplicateReleaser` | 44 | `InvalidBasisPoints` |
| 18 | `AcceptanceRequired` | 45 | `SplitAmountOverflow` |
| 19 | `AcceptanceNotConfigured` | 46 | `InvalidRefundExtension` |
| 20 | `AlreadyAccepted` | 47 | `PoolInsufficient` |
| 21 | `InvalidRefundTo` | 48 | `NotStreamed` |
| 22 | `InvalidReleaseNotBefore` | 49 | `InvalidVestingSchedule` |
| 23 | `ReleaseTooEarly` | 50 | `NothingToWithdraw` |
| 24 | `InvalidReleaser` | 51 | `StreamTopUpUnsupported` |
| 25 | `BatchTooLarge` | 52 | `InvalidSettlementAmount` |
| 26 | `NotPooled` | 53 | `SettlementNotSupported` |
| 27 | `FundingDeadlinePassed` | 54 | `AttesterNotConfigured` |
| 28 | `FundingTargetReached` | 55–59 | `ScheduleTooEarly`…`InvalidSchedule` |
| 29 | `FundingIncomplete` | 4700 | `DuplicateConditionRef` |

Codes 10 and 11 are not defined by the contract. Unknown/newer codes are kept
as `ContractError{Code: n, Name: "UnknownContractError"}`. Contract error
values can also arrive per operation — `SettleMany` turns a rejected op into a
`*ContractError` in `Results`, so `errors.Is(result.Err, escrow.ErrNotFunded)`
works there too.

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

The lifecycle, pooled and batch methods that a party other than the client also
signs — `Accept`, `Cancel`, `TransferPayee`, `Contribute`, `ClaimRefund` — take
that party's `Signer` per call, so a back office can hold the payer's fee
account and the payee's or a contributor's key side by side. Passing `nil` uses
`Config.Signer`. When the acting party *is* `Config.Signer` it is the
transaction source and authorizes with its envelope signature (any `Signer`
works). When it differs, `Config.Signer` stays the source and pays the fee while
the acting party signs its own Soroban auth entry, which requires a
`*KeypairSigner` — the same rule as the approval paths — and otherwise returns
`ErrUnsupportedAuthorization`.

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
code mapping. `client_test.go` also pins the argument XDR of every new entry
point against the contract's parameter order — the acceptance gate, `accept` /
`cancel` / `transfer_payee`, the pooled create / contribute / claim path,
`create_escrows`' `CreateItem` maps, and `settle_many`'s `(u64, SettleAction)`
tuples — and `scval_test.go` decodes `PooledData`, `Contribution` (Some and
None), and `Vec<Result<(), Error>>` with mixed `Ok`/`Err` entries in input
order. `go test ./...` does not touch the network.

### Integration tests

`integration_test.go` is behind the `integration` build tag and is skipped
unless `ESCROW_INTEGRATION=1`. It covers:

- create → `get_status` → `get_escrow` → `release`
- create → `refund`
- create → `top_up` → `release_with_approvals` / `refund_with_approvals`
- acceptance escrow → release rejected (`ErrAcceptanceRequired`) → payee
  `accept` with a signer that is not `Config.Signer` → release; a second accept
  is `ErrAlreadyAccepted`
- acceptance escrow → `cancel` before acceptance → `EscrowStatusCancelled`, the
  record reclaimed (`ErrNotFound`)
- pooled escrow → two `contribute`s → claim rejected before the deadline →
  deadline passes below the target → two `claim_refund`s (one per contributor)
  → `EscrowStatusRefunded`, both records marked refunded, a second claim is
  `ErrAlreadyRefunded`
- `create_escrows` of two items → `settle_many` with two releases and one
  duplicate op (`ErrNotFunded` in `Results`, in input order)
- unknown id → `ErrNotFound` (contract code 1)

The two-party cases need `STELLAR_CONTRIBUTOR_SECRET_KEY` and skip without it,
so a green run never silently dropped the different-signer path.

Run against testnet or a local quickstart network:

```bash
cd sdk-go
ESCROW_INTEGRATION=1 \
ESCROW_CONTRACT_ID=C... \
ESCROW_TOKEN_ID=C... \
STELLAR_RPC_URL=https://soroban-testnet.stellar.org \
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015" \
STELLAR_SECRET_KEY=S... \
STELLAR_CONTRIBUTOR_SECRET_KEY=S... \
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
| `STELLAR_CONTRIBUTOR_SECRET_KEY` | second funded account: the payee in the acceptance case and one contributor in the pooled case |

The integration tests spend real testnet/local funds (trivially), and the secret
key is read from the environment only. Never commit it.

## CI

`.github/workflows/sdk-go.yml` has two jobs:

- **unit** — `gofmt` check, `go vet ./...`, `go test ./...`; no services, no
  network, always expected to be green.
- **integration** — starts `stellar/quickstart:latest` as a service on local
  mode (RPC at `http://localhost:8000/rpc`), builds the contract WASM with Rust,
  installs the Stellar CLI version pinned in `scripts/stellar-cli-version`,
  deploys a native asset SAC plus the escrow contract, generates and funds the
  deployer *and* a `contributor` identity, and exports the variables above
  before running `go test -tags=integration`.

The integration job is intentionally additive: it is the environment-dependent
job. If quickstart's service-container startup, friendbot funding, or contract
deployment is unavailable in a given runner image, the unit job remains the
authoritative offline gate and the integration job's log identifies which setup
step failed. The full flow (quickstart + WASM build + deploy + integration
tests) has been run locally against Stellar CLI v28.1.0; CI runner behavior can
still differ, so treat the integration job's log as the source of truth there.

## Versioning

See [`VERSIONING.md`](./VERSIONING.md). In short: the module is `v0.x` while
the contract is testnet-only, breaking Go API changes bump the minor version,
and releases are tagged `sdk-go/vX.Y.Z` (the prefix is required for a Go module
in a subdirectory).
