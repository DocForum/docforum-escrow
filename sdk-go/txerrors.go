package escrow

import (
	"fmt"
	"regexp"
	"strconv"

	protocol "github.com/stellar/go-stellar-sdk/protocols/rpc"
	"github.com/stellar/go-stellar-sdk/xdr"
)

var (
	contractErrorPattern = regexp.MustCompile(`(?i)Error\s*\(\s*Contract\s*,\s*#?(\d+)\s*\)`)
	contractCodePattern  = regexp.MustCompile(`(?i)contract\s+(?:error|code)\s*[:#]?\s*(\d+)`)
)

func parseSimulationError(message string) error {
	if code, ok := contractCodeFromMessage(message); ok {
		return NewContractError(code)
	}
	return fmt.Errorf("%w: %s", ErrSimulationFailed, message)
}

func contractCodeFromMessage(message string) (uint32, bool) {
	for _, pattern := range []*regexp.Regexp{contractErrorPattern, contractCodePattern} {
		matches := pattern.FindStringSubmatch(message)
		if len(matches) != 2 {
			continue
		}
		code, err := strconv.ParseUint(matches[1], 10, 32)
		if err != nil {
			continue
		}
		return uint32(code), true
	}
	return 0, false
}

func errorFromSendFailure(response protocol.SendTransactionResponse) error {
	if response.ErrorResultXDR != "" {
		if code, ok := contractCodeFromDiagnosticXDR(response.DiagnosticEventsXDR); ok {
			return NewContractError(code)
		}
		return errorFromResultXDR(response.ErrorResultXDR)
	}
	if code, ok := contractCodeFromDiagnosticXDR(response.DiagnosticEventsXDR); ok {
		return NewContractError(code)
	}
	if response.Status != "" {
		return fmt.Errorf("%w: submission status %s", ErrTransactionFailed, response.Status)
	}
	return ErrTransactionFailed
}

func errorFromTransaction(response protocol.GetTransactionResponse) error {
	if code, ok := contractCodeFromDiagnosticXDR(response.DiagnosticEventsXDR); ok {
		return NewContractError(code)
	}
	if code, ok := contractCodeFromMeta(response.ResultMetaXDR); ok {
		return NewContractError(code)
	}
	if response.ResultXDR != "" {
		return errorFromResultXDR(response.ResultXDR)
	}
	if response.Status != "" {
		return fmt.Errorf("%w: transaction status %s", ErrTransactionFailed, response.Status)
	}
	return ErrTransactionFailed
}

func errorFromResultXDR(resultXDR string) error {
	var result xdr.TransactionResult
	if err := xdr.SafeUnmarshalBase64(resultXDR, &result); err != nil {
		return fmt.Errorf("%w: decode transaction result: %v", ErrTransactionFailed, err)
	}
	if operations, ok := result.OperationResults(); ok {
		for _, operation := range operations {
			if operation.Tr == nil {
				continue
			}
			invoke, ok := operation.Tr.GetInvokeHostFunctionResult()
			if !ok {
				continue
			}
			if invoke.Code != xdr.InvokeHostFunctionResultCodeInvokeHostFunctionSuccess {
				return fmt.Errorf("%w: invoke host function failed (%s), transaction result %s",
					ErrTransactionFailed, invoke.Code, result.Result.Code)
			}
		}
	}
	return fmt.Errorf("%w: transaction result %s", ErrTransactionFailed, result.Result.Code)
}

func contractCodeFromMeta(metaXDR string) (uint32, bool) {
	if metaXDR == "" {
		return 0, false
	}
	var meta xdr.TransactionMeta
	if err := xdr.SafeUnmarshalBase64(metaXDR, &meta); err != nil {
		return 0, false
	}
	events, err := meta.GetDiagnosticEvents()
	if err != nil {
		return 0, false
	}
	return contractCodeFromDiagnosticEvents(events)
}

func contractCodeFromDiagnosticXDR(encoded []string) (uint32, bool) {
	events := make([]xdr.DiagnosticEvent, 0, len(encoded))
	for _, raw := range encoded {
		var event xdr.DiagnosticEvent
		if err := xdr.SafeUnmarshalBase64(raw, &event); err != nil {
			continue
		}
		events = append(events, event)
	}
	return contractCodeFromDiagnosticEvents(events)
}

func contractCodeFromDiagnosticEvents(events []xdr.DiagnosticEvent) (uint32, bool) {
	for _, event := range events {
		if event.Event.Body.V0 == nil {
			continue
		}
		for _, topic := range event.Event.Body.V0.Topics {
			if code, ok := contractCodeFromScVal(topic); ok {
				return code, true
			}
		}
		if code, ok := contractCodeFromScVal(event.Event.Body.V0.Data); ok {
			return code, true
		}
	}
	return 0, false
}

// contractCodeFromScVal recursively searches a diagnostic event payload for the
// contract Error(Contract, #n) ScVal. Contract errors can be nested inside vecs
// or maps depending on the host version.
func contractCodeFromScVal(value xdr.ScVal) (uint32, bool) {
	switch value.Type {
	case xdr.ScValTypeScvError:
		if value.Error == nil || value.Error.Type != xdr.ScErrorTypeSceContract || value.Error.ContractCode == nil {
			return 0, false
		}
		return uint32(*value.Error.ContractCode), true
	case xdr.ScValTypeScvVec:
		if value.Vec == nil || *value.Vec == nil {
			return 0, false
		}
		for _, item := range **value.Vec {
			if code, ok := contractCodeFromScVal(item); ok {
				return code, true
			}
		}
	case xdr.ScValTypeScvMap:
		if value.Map == nil || *value.Map == nil {
			return 0, false
		}
		for _, entry := range **value.Map {
			if code, ok := contractCodeFromScVal(entry.Key); ok {
				return code, true
			}
			if code, ok := contractCodeFromScVal(entry.Val); ok {
				return code, true
			}
		}
	}
	return 0, false
}

func returnValueFromMeta(metaXDR string) (*xdr.ScVal, error) {
	if metaXDR == "" {
		return nil, nil
	}
	var meta xdr.TransactionMeta
	if err := xdr.SafeUnmarshalBase64(metaXDR, &meta); err != nil {
		return nil, fmt.Errorf("escrow: decode transaction meta: %w", err)
	}
	switch meta.V {
	case 3:
		if meta.V3 != nil && meta.V3.SorobanMeta != nil {
			value := meta.V3.SorobanMeta.ReturnValue
			return &value, nil
		}
	case 4:
		if meta.V4 != nil && meta.V4.SorobanMeta != nil {
			return meta.V4.SorobanMeta.ReturnValue, nil
		}
	}
	return nil, nil
}
