package escrow

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"

	"github.com/stellar/go-stellar-sdk/xdr"
)

// SupportedContractVersionMin and SupportedContractVersionMax bound the
// contract versions this client talks to: at least Min (inclusive) and below
// Max (exclusive). They mirror SUPPORTED_CONTRACT_VERSIONS in the TypeScript
// SDK (sdk/src/contract-version.ts); change both together.
const (
	SupportedContractVersionMin = "2.0.0"
	SupportedContractVersionMax = "4.0.0"
)

// SolvencyReport is the result of Solvency: the contract's balance of one
// token and the sum of the amounts of every still-Funded escrow in it. The
// contract is solvent for the token exactly when Balance >= Liabilities.
type SolvencyReport struct {
	Balance     *big.Int
	Liabilities *big.Int
	Solvent     bool
}

// VersionUnavailableError means the deployment has no version() entry point,
// which is what an older contract looks like from here. It is errors.Is-able to
// ErrVersionUnavailable.
type VersionUnavailableError struct {
	ContractID string
}

// Error implements error.
func (e *VersionUnavailableError) Error() string {
	return fmt.Sprintf("%v: contract %s does not expose version()", ErrVersionUnavailable, e.ContractID)
}

// Is lets errors.Is(err, ErrVersionUnavailable) work through wrapping.
func (e *VersionUnavailableError) Is(target error) bool { return target == ErrVersionUnavailable }

// UnsupportedContractVersionError means version() returned a value outside
// SupportedContractVersionMin..SupportedContractVersionMax. It is
// errors.Is-able to ErrUnsupportedContractVersion.
type UnsupportedContractVersionError struct {
	ContractID string
	Version    string
}

// Error implements error.
func (e *UnsupportedContractVersionError) Error() string {
	return fmt.Sprintf(
		"%v: contract %s is version %s; this SDK supports >=%s <%s",
		ErrUnsupportedContractVersion, e.ContractID, e.Version,
		SupportedContractVersionMin, SupportedContractVersionMax,
	)
}

// Is lets errors.Is(err, ErrUnsupportedContractVersion) work through wrapping.
func (e *UnsupportedContractVersionError) Is(target error) bool {
	return target == ErrUnsupportedContractVersion
}

var contractVersionPattern = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$`)

// isSupportedContractVersion reports whether version is inside the supported
// range. An unparsable version is never supported.
func isSupportedContractVersion(version string) bool {
	parsed, ok := parseContractVersion(version)
	if !ok {
		return false
	}
	min, _ := parseContractVersion(SupportedContractVersionMin)
	max, _ := parseContractVersion(SupportedContractVersionMax)
	return compareContractVersions(parsed, min) >= 0 && compareContractVersions(parsed, max) < 0
}

func parseContractVersion(version string) ([3]int, bool) {
	match := contractVersionPattern.FindStringSubmatch(strings.TrimSpace(version))
	if match == nil {
		return [3]int{}, false
	}
	var parsed [3]int
	for i := 0; i < 3; i++ {
		value, err := strconv.Atoi(match[i+1])
		if err != nil {
			return [3]int{}, false
		}
		parsed[i] = value
	}
	return parsed, true
}

func compareContractVersions(a, b [3]int) int {
	for i := 0; i < 3; i++ {
		if a[i] != b[i] {
			return a[i] - b[i]
		}
	}
	return 0
}

// Version reads the contract's semantic version, e.g. "3.1.0". An older
// deployment with no version() function returns a *VersionUnavailableError
// instead of a generic simulation failure.
func (c *Client) Version(ctx context.Context) (string, error) {
	value, err := c.readInvoke(ctx, "version", nil)
	if err != nil {
		if isMissingFunctionError(err) {
			return "", &VersionUnavailableError{ContractID: c.contractID}
		}
		return "", err
	}
	return decodeString(value)
}

// IsPaused reports whether the contract is paused. Writes revert while it is.
func (c *Client) IsPaused(ctx context.Context) (bool, error) {
	value, err := c.readInvoke(ctx, "is_paused", nil)
	if err != nil {
		return false, err
	}
	return decodeBool(value)
}

// GetPauseAdmin returns the address allowed to pause/unpause the contract, or
// nil when the deployment has no pause administrator.
func (c *Client) GetPauseAdmin(ctx context.Context) (*string, error) {
	value, err := c.readInvoke(ctx, "get_pause_admin", nil)
	if err != nil {
		return nil, err
	}
	return decodeOptionAddress(value)
}

// Solvency reads (balance, liabilities) for token, so an integrator can check
// the contract's backing without trusting an off-chain report.
func (c *Client) Solvency(ctx context.Context, token string) (SolvencyReport, error) {
	tokenValue, err := scvAddress(token)
	if err != nil {
		return SolvencyReport{}, err
	}
	value, err := c.readInvoke(ctx, "solvency", []xdr.ScVal{tokenValue})
	if err != nil {
		return SolvencyReport{}, err
	}
	values, err := decodeVec(value)
	if err != nil {
		return SolvencyReport{}, err
	}
	if len(values) != 2 {
		return SolvencyReport{}, fmt.Errorf("escrow: solvency returned %d values, want 2", len(values))
	}
	balance, err := decodeI128(values[0])
	if err != nil {
		return SolvencyReport{}, err
	}
	liabilities, err := decodeI128(values[1])
	if err != nil {
		return SolvencyReport{}, err
	}
	return SolvencyReport{
		Balance:     balance,
		Liabilities: liabilities,
		Solvent:     balance.Cmp(liabilities) >= 0,
	}, nil
}

// VerifyContractVersion reads version() and rejects a missing or unsupported
// one. Unlike the lazy Config.ContractVersionCheck, calling this is an explicit
// request, so a deployment without version() is an error.
func (c *Client) VerifyContractVersion(ctx context.Context) error {
	version, ok, err := c.contractVersion(ctx)
	if err != nil {
		return err
	}
	if !ok {
		return &VersionUnavailableError{ContractID: c.contractID}
	}
	if !isSupportedContractVersion(version) {
		return &UnsupportedContractVersionError{ContractID: c.contractID, Version: version}
	}
	return nil
}

// contractVersion reads version() and reports whether the deployment has one.
// A missing function is not an error here: the caller decides what it means.
func (c *Client) contractVersion(ctx context.Context) (string, bool, error) {
	version, err := c.Version(ctx)
	var unavailable *VersionUnavailableError
	if errors.As(err, &unavailable) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return version, true, nil
}

// ensureContractVersionChecked runs the configured version check once. A
// failed lookup in Auto mode is not cached, so a transient RPC failure is
// retried on the next write; a rejection (unsupported version) is returned but
// the next write checks again.
func (c *Client) ensureContractVersionChecked(ctx context.Context) error {
	if c.contractVersionCheck == ContractVersionCheckOff {
		return nil
	}
	c.versionMu.Lock()
	defer c.versionMu.Unlock()
	if c.contractVersionChecked {
		return nil
	}
	if c.contractVersionCheck == ContractVersionCheckRequired {
		if err := c.VerifyContractVersion(ctx); err != nil {
			return err
		}
		c.contractVersionChecked = true
		return nil
	}
	version, ok, err := c.contractVersion(ctx)
	if err != nil {
		return nil
	}
	if ok && !isSupportedContractVersion(version) {
		return &UnsupportedContractVersionError{ContractID: c.contractID, Version: version}
	}
	c.contractVersionChecked = true
	return nil
}

// missingFunctionPattern mirrors MISSING_FUNCTION_ERROR in the TypeScript SDK:
// Soroban reports an unknown contract entry point this way.
var missingFunctionPattern = regexp.MustCompile(`(?i)non-?existent contract function|Error\(WasmVm, MissingValue\)`)

func isMissingFunctionError(err error) bool {
	return err != nil && missingFunctionPattern.MatchString(err.Error())
}
