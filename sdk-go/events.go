package escrow

import (
	"fmt"
	"strconv"

	"github.com/stellar/go-stellar-sdk/protocols/rpc"
	"github.com/stellar/go-stellar-sdk/xdr"
)

// EventType is the kind of a decoded contract event.
type EventType string

const (
	EventTypeCreated   EventType = "created"
	EventTypeReleased  EventType = "released"
	EventTypeRefunded  EventType = "refunded"
	EventTypeCancelled EventType = "cancelled"
	EventTypeUnknown   EventType = "unknown"
)

// UnknownEvent describes an event that is not (yet) understood by this SDK.
// It is retained so newer event shapes never break a page of results.
type UnknownEvent struct {
	Name   string
	Topics []string
	Data   *xdr.ScVal
}

// Event is a single decoded contract event.
type Event struct {
	Ledger uint32
	Type   EventType
	// Escrow is populated when Type is a lifecycle event: it is the full-state
	// snapshot decoded from the event data payload.
	Escrow *Escrow
	// Unknown is populated when Type is EventTypeUnknown.
	Unknown *UnknownEvent
}

// EventsQuery describes how to page through contract events.
type EventsQuery struct {
	// ContractID filters to one contract. Defaults to the client's contract.
	ContractID string
	// Topics optionally narrows the topics matched.
	Topics [][]string
	// StartLedger is the first ledger to scan (inclusive).
	StartLedger uint32
	// Cursor resumes from a prior page's cursor.
	Cursor string
	// Limit bounds the page size.
	Limit int
}

// GetEventsResult is one page of decoded events plus the cursor to resume from.
type GetEventsResult struct {
	Events       []Event
	Cursor       string
	LatestLedger uint32
}

// decodeTopic renders an event's topic array into human-readable strings.
// Symbols are rendered as-is; numbers as decimals; anything else as a
// placeholder so unknown topic shapes stay inspectable.
func decodeTopic(topics []xdr.ScVal) ([]string, error) {
	out := make([]string, 0, len(topics))
	for _, t := range topics {
		switch {
		case t.Type == xdr.ScValTypeScvSymbol && t.Sym != nil:
			out = append(out, string(*t.Sym))
		case t.Type == xdr.ScValTypeScvU64 && t.U64 != nil:
			out = append(out, strconv.FormatUint(uint64(*t.U64), 10))
		case t.Type == xdr.ScValTypeScvBytes && t.Bytes != nil:
			out = append(out, string(*t.Bytes))
		default:
			out = append(out, fmt.Sprintf("<%s>", t.Type))
		}
	}
	return out, nil
}

// decodeAddressVec decodes a ScVal vec of addresses into a string slice.
func decodeAddressVec(v xdr.ScVal) ([]string, error) {
	vals, err := decodeVec(v)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(vals))
	for _, val := range vals {
		addr, err := decodeAddress(val)
		if err != nil {
			return nil, err
		}
		out = append(out, addr)
	}
	return out, nil
}

// decodeEventSnapshot decodes an ESCROW lifecycle event's data payload (the
// full-state snapshot) into an Escrow. It accepts both the 12-field layout
// (payer ... status) and the 13-field layout (with the trailing fee pair).
func decodeEventSnapshot(data *xdr.ScVal) (*Escrow, error) {
	if data == nil {
		return nil, fmt.Errorf("escrow: event data is nil")
	}
	vals, err := decodeVec(*data)
	if err != nil {
		return nil, err
	}
	if len(vals) < 12 {
		return nil, fmt.Errorf("escrow: event snapshot has %d fields, need at least 12", len(vals))
	}
	hasFee := len(vals) == 13

	e := &Escrow{}
	if e.Payer, err = decodeAddress(vals[0]); err != nil {
		return nil, err
	}
	if e.Payee, err = decodeAddress(vals[1]); err != nil {
		return nil, err
	}
	if e.Token, err = decodeAddress(vals[2]); err != nil {
		return nil, err
	}
	if e.Amount, err = decodeI128(vals[3]); err != nil {
		return nil, err
	}
	if e.ConditionRef, err = decodeString(vals[4]); err != nil {
		return nil, err
	}
	if e.Releasers, err = decodeAddressVec(vals[5]); err != nil {
		return nil, err
	}
	if e.Threshold, err = decodeU32(vals[6]); err != nil {
		return nil, err
	}
	if e.RefundAfter, err = decodeOptionU64(vals[7]); err != nil {
		return nil, err
	}
	if e.NotifyPayee, err = decodeBool(vals[8]); err != nil {
		return nil, err
	}
	if e.RequiresAcceptance, err = decodeBool(vals[9]); err != nil {
		return nil, err
	}
	if e.AcceptedAt, err = decodeOptionU64(vals[10]); err != nil {
		return nil, err
	}
	if e.Status, err = decodeStatus(vals[11]); err != nil {
		return nil, err
	}
	if hasFee {
		feeVals, err := decodeVec(vals[12])
		if err != nil {
			return nil, err
		}
		if len(feeVals) < 2 {
			return nil, fmt.Errorf("escrow: malformed fee pair")
		}
		if feeRecipient, err := decodeOptionAddress(feeVals[0]); err != nil {
			return nil, err
		} else {
			e.FeeRecipient = feeRecipient
		}
		if feeBps, err := decodeU32(feeVals[1]); err != nil {
			return nil, err
		} else {
			e.FeeBps = &feeBps
		}
	}
	return e, nil
}

// decodeContractEvent decodes a single RPC contract event. Events whose topic
// does not begin with ("ESCROW", ...) are reported as Unknown so that newer
// event shapes never fail a whole page of results.
func decodeContractEvent(ev protocol.EventInfo) (Event, error) {
	topics, err := decodeTopicXDR(ev.TopicXDR)
	if err != nil {
		return Event{}, err
	}
	if len(topics) < 3 || topics[0] != "ESCROW" {
		return Event{
			Ledger: uint32(ev.Ledger),
			Type:   EventTypeUnknown,
			Unknown: &UnknownEvent{
				Name:   firstTopic(topics),
				Topics: topics,
				Data:   valueOrNil(ev.ValueXDR),
			},
		}, nil
	}
	action := EventType(topics[1])
	if _, err := strconv.ParseUint(topics[2], 10, 64); err != nil {
		return Event{}, fmt.Errorf("escrow: malformed escrow id in topic: %w", err)
	}
	escrow, err := decodeEventSnapshotXDR(ev.ValueXDR)
	if err != nil {
		return Event{}, err
	}
	return Event{
		Ledger: uint32(ev.Ledger),
		Type:   action,
		Escrow: escrow,
	}, nil
}

func firstTopic(topics []string) string {
	if len(topics) > 0 {
		return topics[0]
	}
	return ""
}

// decodeBase64ScVal decodes one base64-encoded XDR ScVal, as returned by the
// RPC in EventInfo.TopicXDR / EventInfo.ValueXDR.
func decodeBase64ScVal(s string) (xdr.ScVal, error) {
	var v xdr.ScVal
	if err := xdr.SafeUnmarshalBase64(s, &v); err != nil {
		return xdr.ScVal{}, err
	}
	return v, nil
}

// decodeTopicXDR decodes the base64 topic list of an RPC event into strings.
func decodeTopicXDR(b64 []string) ([]string, error) {
	vals := make([]xdr.ScVal, 0, len(b64))
	for _, s := range b64 {
		v, err := decodeBase64ScVal(s)
		if err != nil {
			return nil, err
		}
		vals = append(vals, v)
	}
	return decodeTopic(vals)
}

// valueOrNil decodes a base64 ScVal, returning nil if it is empty or invalid.
// Used for best-effort reporting of unknown events.
func valueOrNil(s string) *xdr.ScVal {
	if s == "" {
		return nil
	}
	v, err := decodeBase64ScVal(s)
	if err != nil {
		return nil
	}
	return &v
}

// decodeEventSnapshotXDR decodes the base64 value of a lifecycle event.
func decodeEventSnapshotXDR(s string) (*Escrow, error) {
	if s == "" {
		return decodeEventSnapshot(nil)
	}
	v, err := decodeBase64ScVal(s)
	if err != nil {
		return nil, err
	}
	return decodeEventSnapshot(&v)
}
