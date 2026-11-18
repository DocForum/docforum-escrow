package escrow

import (
	"errors"
	"fmt"
)

// Sentinel errors for failures that are not contract errors. Contract failures
// are represented by *ContractError so callers can inspect the numeric code.
var (
	// ErrInvalidArgument means a caller-supplied value failed client-side
	// validation before any network request was made.
	ErrInvalidArgument = errors.New("escrow: invalid argument")

	// ErrInvalidContractID means the configured contract address is not a
	// valid Stellar contract strkey.
	ErrInvalidContractID = errors.New("escrow: invalid contract id")

	// ErrSignerRequired means the operation needs a signer but Config.Signer
	// was nil.
	ErrSignerRequired = errors.New("escrow: signer required")

	// ErrWalletRejected means a Signer returned an error. The underlying error
	// is wrapped alongside this sentinel.
	ErrWalletRejected = errors.New("escrow: signer rejected the transaction")

	// ErrNetworkMismatch means the client was configured for a network that
	// this SDK refuses to use (mainnet), or the RPC server reports a passphrase
	// different from Config.NetworkPassphrase. Testnet/local only: see
	// ARCHITECTURE_ESSENTIALS.md hard rule 4.
	ErrNetworkMismatch = errors.New("escrow: network passphrase mismatch")

	// ErrSimulationFailed means Soroban simulation failed for a reason other
	// than a contract error (for example a host error or malformed call).
	ErrSimulationFailed = errors.New("escrow: simulation failed")

	// ErrTransactionFailed means the transaction was submitted but did not
	// succeed, and no contract error code was available in the result or
	// diagnostic events.
	ErrTransactionFailed = errors.New("escrow: transaction failed")

	// ErrUnsupportedAuthorization means the simulation required an
	// authorization entry for an address the client cannot sign for. For a
	// single-signer call this normally means notify_payee was true and the
	// payee is not the configured signer.
	ErrUnsupportedAuthorization = errors.New("escrow: unsupported authorization requirement")

	// ErrTimeout means the client gave up waiting for the transaction to
	// reach a terminal state at Config.PollTimeout.
	ErrTimeout = errors.New("escrow: timed out waiting for transaction")
)

// contractErrorNames maps the contract's `Error` enum (contracts/escrow/src/lib.rs)
// to the names used in Go errors. Codes 10 and 11 are intentionally absent:
// the contract does not define them.
var contractErrorNames = map[uint32]string{
	1:  "NotFound",
	2:  "InvalidAmount",
	3:  "Unauthorized",
	4:  "NotFunded",
	5:  "InvalidRefundAfter",
	6:  "BalanceMismatch",
	7:  "ConditionRefTooLong",
	8:  "DisallowedToken",
	9:  "CallbackFailed",
	12: "Overflow",
	13: "InvalidThreshold",
	14: "TooManyReleasers",
	15: "ThresholdNotMet",
	16: "DuplicateApprover",
	17: "DuplicateReleaser",
	18: "AcceptanceRequired",
	19: "AcceptanceNotConfigured",
	20: "AlreadyAccepted",
}

// ContractError is an error returned by the escrow contract. Code matches the
// contract's `Error` enum (1..20; codes 10 and 11 are unused). Use errors.As to
// extract it, or errors.Is with one of the Err* sentinels below.
type ContractError struct {
	Code uint32
	Name string
}

// NewContractError returns a *ContractError for a contract error code. Unknown
// codes are retained as Code with Name "UnknownContractError" so a newer
// contract can still fail loudly and inspectably against an older SDK.
func NewContractError(code uint32) *ContractError {
	name, ok := contractErrorNames[code]
	if !ok {
		name = "UnknownContractError"
	}
	return &ContractError{Code: code, Name: name}
}

// Error implements error.
func (e *ContractError) Error() string {
	return fmt.Sprintf("escrow: contract error %d (%s)", e.Code, e.Name)
}

// Is lets errors.Is(err, ErrNotFound) work through wrapping, comparing the
// contract code rather than pointer identity.
func (e *ContractError) Is(target error) bool {
	var other *ContractError
	if !errors.As(target, &other) {
		return false
	}
	return e.Code == other.Code
}

// Contract error sentinels, one per code the contract defines. They are
// pointers so errors.Is can compare codes, and errors.As works on any concrete
// *ContractError returned by the client.
var (
	ErrNotFound                = NewContractError(1)
	ErrInvalidAmount           = NewContractError(2)
	ErrUnauthorized            = NewContractError(3)
	ErrNotFunded               = NewContractError(4)
	ErrInvalidRefundAfter      = NewContractError(5)
	ErrBalanceMismatch         = NewContractError(6)
	ErrConditionRefTooLong     = NewContractError(7)
	ErrDisallowedToken         = NewContractError(8)
	ErrCallbackFailed          = NewContractError(9)
	ErrOverflow                = NewContractError(12)
	ErrInvalidThreshold        = NewContractError(13)
	ErrTooManyReleasers        = NewContractError(14)
	ErrThresholdNotMet         = NewContractError(15)
	ErrDuplicateApprover       = NewContractError(16)
	ErrDuplicateReleaser       = NewContractError(17)
	ErrAcceptanceRequired      = NewContractError(18)
	ErrAcceptanceNotConfigured = NewContractError(19)
	ErrAlreadyAccepted         = NewContractError(20)
)
