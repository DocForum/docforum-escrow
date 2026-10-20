package escrow

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/stellar/go-stellar-sdk/xdr"
)

func TestContractErrorCodeMapping(t *testing.T) {
	want := map[uint32]string{
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
	for code, name := range want {
		err := NewContractError(code)
		if err.Code != code || err.Name != name {
			t.Fatalf("NewContractError(%d) = %#v, want name %q", code, err, name)
		}
	}

	unknown := NewContractError(999)
	if unknown.Code != 999 || unknown.Name != "UnknownContractError" {
		t.Fatalf("unknown code = %#v", unknown)
	}
}

func TestContractErrorIsAndAs(t *testing.T) {
	wrapped := fmt.Errorf("release failed: %w", NewContractError(3))
	if !errors.Is(wrapped, ErrUnauthorized) {
		t.Fatal("errors.Is did not match ErrUnauthorized")
	}
	if errors.Is(wrapped, ErrNotFound) {
		t.Fatal("errors.Is matched the wrong contract error")
	}

	var contractErr *ContractError
	if !errors.As(wrapped, &contractErr) {
		t.Fatal("errors.As did not extract *ContractError")
	}
	if contractErr.Code != 3 || contractErr.Name != "Unauthorized" {
		t.Fatalf("extracted %#v", contractErr)
	}

	if got := ErrNotFound.Error(); !strings.Contains(got, "NotFound") {
		t.Fatalf("ErrNotFound.Error() = %q", got)
	}
}

func TestParseSimulationError(t *testing.T) {
	tests := []struct {
		message string
		target  error
	}{
		{"HostError: Error(Contract, #1)", ErrNotFound},
		{"simulation failed: Error(Contract, #7)", ErrConditionRefTooLong},
		{"host error: error(contract, #20)", ErrAlreadyAccepted},
		{"contract code: 15", ErrThresholdNotMet},
	}
	for _, test := range tests {
		err := parseSimulationError(test.message)
		if !errors.Is(err, test.target) {
			t.Fatalf("parseSimulationError(%q) = %v, want %v", test.message, err, test.target)
		}
	}

	err := parseSimulationError("HostError: Error(WasmVm, MissingValue)")
	if !errors.Is(err, ErrSimulationFailed) {
		t.Fatalf("non-contract simulation error = %v", err)
	}
}

func TestContractCodeFromScValRecurses(t *testing.T) {
	code := xdr.Uint32(13)
	errorVal, err := xdr.NewScVal(xdr.ScValTypeScvError, xdr.ScError{
		Type:         xdr.ScErrorTypeSceContract,
		ContractCode: &code,
	})
	if err != nil {
		t.Fatal(err)
	}
	nested := scvVec([]xdr.ScVal{
		scvString("context"),
		scvMap([]xdr.ScMapEntry{{Key: scvSymbol("error"), Val: errorVal}}),
	})
	got, ok := contractCodeFromScVal(nested)
	if !ok || got != 13 {
		t.Fatalf("contractCodeFromScVal = %d, %v", got, ok)
	}
}

func TestContractCodeFromDiagnosticEvents(t *testing.T) {
	code := xdr.Uint32(9)
	errorVal, err := xdr.NewScVal(xdr.ScValTypeScvError, xdr.ScError{
		Type:         xdr.ScErrorTypeSceContract,
		ContractCode: &code,
	})
	if err != nil {
		t.Fatal(err)
	}
	events := []xdr.DiagnosticEvent{{
		Event: xdr.ContractEvent{
			Type: xdr.ContractEventTypeDiagnostic,
			Body: xdr.ContractEventBody{
				V: 0,
				V0: &xdr.ContractEventV0{
					Topics: []xdr.ScVal{scvSymbol("error")},
					Data:   errorVal,
				},
			},
		},
	}}
	got, ok := contractCodeFromDiagnosticEvents(events)
	if !ok || got != 9 {
		t.Fatalf("contractCodeFromDiagnosticEvents = %d, %v", got, ok)
	}

	encoded := make([]string, 0, 1)
	raw, err := xdr.MarshalBase64(events[0])
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, raw)
	got, ok = contractCodeFromDiagnosticXDR(encoded)
	if !ok || got != 9 {
		t.Fatalf("contractCodeFromDiagnosticXDR = %d, %v", got, ok)
	}
}

func TestReturnValueFromMeta(t *testing.T) {
	meta := xdr.TransactionMeta{
		V: 3,
		V3: &xdr.TransactionMetaV3{
			SorobanMeta: &xdr.SorobanTransactionMeta{
				ReturnValue: scvU64(44),
			},
		},
	}
	encoded, err := xdr.MarshalBase64(meta)
	if err != nil {
		t.Fatal(err)
	}
	value, err := returnValueFromMeta(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if value == nil {
		t.Fatal("returnValueFromMeta returned nil")
	}
	got, err := decodeU64(*value)
	if err != nil || got != 44 {
		t.Fatalf("return value = %d, %v", got, err)
	}
}

func TestStatusDecoding(t *testing.T) {
	for _, status := range []EscrowStatus{EscrowStatusFunded, EscrowStatusReleased, EscrowStatusRefunded} {
		got, err := decodeStatus(scvU32(uint32(status)))
		if err != nil || got != status {
			t.Fatalf("decodeStatus(%d) = %v, %v", status, got, err)
		}
	}
	if _, err := decodeStatus(scvU32(99)); err == nil {
		t.Fatal("decodeStatus accepted an unknown status")
	}
	if EscrowStatusFunded.String() != "Funded" || !EscrowStatusRefunded.IsValid() {
		t.Fatal("status String/IsValid failed")
	}
}
