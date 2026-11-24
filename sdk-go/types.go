package escrow

import (
	"fmt"
	"math/big"
)

// EscrowStatus mirrors the contract's EscrowStatus enum.
type EscrowStatus uint32

const (
	EscrowStatusFunded    EscrowStatus = 0
	EscrowStatusReleased  EscrowStatus = 1
	EscrowStatusRefunded  EscrowStatus = 2
	EscrowStatusCancelled EscrowStatus = 3
)

// String returns the contract's variant name.
func (s EscrowStatus) String() string {
	switch s {
	case EscrowStatusFunded:
		return "Funded"
	case EscrowStatusReleased:
		return "Released"
	case EscrowStatusRefunded:
		return "Refunded"
	case EscrowStatusCancelled:
		return "Cancelled"
	default:
		return fmt.Sprintf("EscrowStatus(%d)", uint32(s))
	}
}

// IsValid reports whether s is a known contract status.
func (s EscrowStatus) IsValid() bool {
	return s <= EscrowStatusCancelled
}

// Escrow is everything the contract stores about one escrow, as returned by
// GetEscrow. Amount is a *big.Int because the contract stores an i128; never
// convert it to int64.
type Escrow struct {
	Payer        string
	Payee        string
	Token        string
	Amount       *big.Int
	ConditionRef string
	Releasers    []string
	Threshold    uint32
	// RefundAfter is an optional unix-seconds deadline after which anyone may
	// refund, always back to Payer. nil means no timeout.
	RefundAfter *uint64
	// RefundTo is the destination for refunds (releaser or timeout). Defaults
	// to Payer if not set. Added in ADR 0009.
	RefundTo *string
	// ReleaseNotBefore is an optional ledger timestamp before which release is
	// not allowed. nil means no time lock.
	ReleaseNotBefore *uint64
	NotifyPayee      bool
	Status           EscrowStatus
	// RequiresAcceptance and AcceptedAt are present in EscrowData in current
	// contract versions. They are exposed so callers can decode the full
	// record; older deployments simply leave them zero/nil.
	RequiresAcceptance bool
	AcceptedAt         *uint64
}

// CreateEscrowParams are the arguments for CreateEscrow. Payer is optional: when
// empty, the configured signer's address is used. The signer must be the payer,
// or the contract's payer authorization cannot be satisfied by this call.
type CreateEscrowParams struct {
	Payer        string
	Payee        string
	Token        string
	Amount       *big.Int
	ConditionRef string
	Releaser     string
	RefundAfter  *uint64
	NotifyPayee  bool
	// RefundTo is an optional refund destination distinct from the payer.
	// If set, all refunds (releaser and timeout) go to this address.
	RefundTo *string
	// ReleaseNotBefore is an optional ledger timestamp before which release
	// is not allowed. If set, the escrow cannot be released before this time.
	ReleaseNotBefore *uint64
}

// CreateEscrowResult is returned by CreateEscrow, CreateEscrowWithReleasers,
// CreateEscrowWithReleaseTime, CreateEscrowWithAcceptance and
// CreatePooledEscrow.
type CreateEscrowResult struct {
	EscrowID uint64
	TxHash   string
}

// TxResult is returned by state-changing calls that do not return a value.
type TxResult struct {
	TxHash string
	Ledger uint32
}

// CreateEscrowWithReleasersParams are the arguments for an M-of-N escrow.
type CreateEscrowWithReleasersParams struct {
	// Payer is optional; it defaults to the configured signer's address.
	Payer        string
	Payee        string
	Token        string
	Amount       *big.Int
	ConditionRef string
	Releasers    []string
	Threshold    uint32
	RefundAfter  *uint64
	NotifyPayee  bool
	// RefundTo is an optional refund destination distinct from the payer.
	// If set, all refunds (releaser and timeout) go to this address.
	RefundTo *string
}

// CreateEscrowWithReleaseTimeParams are the arguments for creating an escrow
// with a time-locked release (create_escrow_release_time).
type CreateEscrowWithReleaseTimeParams struct {
	Payer            string
	Payee            string
	Token            string
	Amount           *big.Int
	ConditionRef     string
	Releaser         string
	RefundAfter      *uint64
	NotifyPayee      bool
	RefundTo         *string
	ReleaseNotBefore *uint64
}

// CreateEscrowWithAcceptanceParams are the arguments for an escrow with the
// optional payee-acceptance gate (create_escrow_with_acceptance, issue #25).
// RequiresAcceptance is the contract's `requires_acceptance` flag: pass true to
// gate release on the payee's accept call and to open the payer's cancel
// window; false creates exactly the same escrow as CreateEscrow.
type CreateEscrowWithAcceptanceParams struct {
	// Payer is optional; it defaults to the configured signer's address.
	Payer              string
	Payee              string
	Token              string
	Amount             *big.Int
	ConditionRef       string
	Releaser           string
	RefundAfter        *uint64
	RequiresAcceptance bool
	// RefundTo is an optional refund destination distinct from the payer.
	RefundTo *string
}

// CreatePooledEscrowParams are the arguments for a pooled escrow: one
// agreement funded by many contributors (create_pooled_escrow, issue #113 and
// docs/adr/0011). FundingTarget is in raw token units and must be positive;
// FundingDeadline is unix seconds and must be in the future. The creator funds
// nothing at creation.
type CreatePooledEscrowParams struct {
	// Creator is optional; it defaults to the configured signer's address.
	Creator         string
	Payee           string
	Token           string
	FundingTarget   *big.Int
	ConditionRef    string
	Releaser        string
	FundingDeadline uint64
}

// PooledData is a pooled escrow's immutable funding configuration, as returned
// by GetPooled. The aggregate funded amount is Escrow.Amount (from GetEscrow).
type PooledData struct {
	FundingTarget   *big.Int
	FundingDeadline uint64
}

// Contribution is one payer's record on a pooled escrow, as returned by
// GetContribution. Amount accumulates every accepted contribution and
// Refunded is set once that payer has claimed their refund.
type Contribution struct {
	Amount   *big.Int
	Refunded bool
}

// CreateItem is one escrow in a batched create_escrows call. It mirrors the
// single-escrow creation parameters minus the batch-wide payer.
type CreateItem struct {
	Payee        string
	Token        string
	Amount       *big.Int
	ConditionRef string
	Releaser     string
	RefundAfter  *uint64
}

// CreateEscrowsParams are the arguments for CreateEscrows. Payer is optional;
// it defaults to (and must match) the configured signer, which authorizes the
// whole batch once.
type CreateEscrowsParams struct {
	Payer string
	Items []CreateItem
}

// CreateEscrowsResult is returned by CreateEscrows. EscrowIDs is in input
// order across every chunk; TxHashes has one entry per transaction sent
// (len(Items) / MaxBatchSize, rounded up). When a later chunk fails, both
// slices describe only the chunks that committed before the failure, and the
// returned error is the failing chunk's error.
type CreateEscrowsResult struct {
	EscrowIDs []uint64
	TxHashes  []string
}

// SettleAction is one of settle_many's two operations: Release pays the
// escrow's stored payee, Refund returns the funds to the stored refund
// destination. It mirrors the contract's SettleAction enum.
type SettleAction uint32

const (
	SettleRelease SettleAction = 0
	SettleRefund  SettleAction = 1
)

// String returns the contract's variant name.
func (a SettleAction) String() string {
	switch a {
	case SettleRelease:
		return "Release"
	case SettleRefund:
		return "Refund"
	default:
		return fmt.Sprintf("SettleAction(%d)", uint32(a))
	}
}

// IsValid reports whether a is a known settle action.
func (a SettleAction) IsValid() bool {
	return a == SettleRelease || a == SettleRefund
}

// SettleOp is one operation in a settle_many call.
type SettleOp struct {
	EscrowID uint64
	Action   SettleAction
}

// SettleOpResult is the contract's per-op outcome, always in input order.
// Err is nil when the contract settled that escrow; a non-nil Err is the
// contract's rejection (for example *ContractError Unauthorized or NotFunded)
// and means the escrow was not touched.
type SettleOpResult struct {
	EscrowID uint64
	Action   SettleAction
	Err      error
}

// OK reports whether the contract settled this op.
func (r SettleOpResult) OK() bool {
	return r.Err == nil
}

// SettleManyResult is returned by SettleMany. Results has one entry per input
// op, in input order, across every chunk. TxHashes has one entry per
// transaction sent. When a later chunk fails, both slices describe only the
// chunks that committed before the failure, and the returned error is the
// failing chunk's error — a per-op rejection inside a successful chunk is in
// Results, never in the returned error.
type SettleManyResult struct {
	Results  []SettleOpResult
	TxHashes []string
}
