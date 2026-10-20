package escrow

import (
	"fmt"
	"math/big"
)

// EscrowStatus mirrors the contract's EscrowStatus enum.
type EscrowStatus uint32

const (
	EscrowStatusFunded   EscrowStatus = 0
	EscrowStatusReleased EscrowStatus = 1
	EscrowStatusRefunded EscrowStatus = 2
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
	default:
		return fmt.Sprintf("EscrowStatus(%d)", uint32(s))
	}
}

// IsValid reports whether s is a known contract status.
func (s EscrowStatus) IsValid() bool {
	return s <= EscrowStatusRefunded
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
	NotifyPayee bool
	Status      EscrowStatus
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
}

// CreateEscrowResult is returned by CreateEscrow and CreateEscrowWithReleasers.
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
}
