package escrow

import (
	"fmt"
	"math/big"
	"strings"

	"github.com/stellar/go-stellar-sdk/strkey"
	"github.com/stellar/go-stellar-sdk/xdr"
)

var (
	minI128 = new(big.Int).Neg(new(big.Int).Lsh(big.NewInt(1), 127))
	maxI128 = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 127), big.NewInt(1))
	two128  = new(big.Int).Lsh(big.NewInt(1), 128)
	mask64  = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 64), big.NewInt(1))
)

// bigIntToI128 encodes a signed integer into Soroban's Int128Parts (hi is the
// signed high 64 bits, lo the unsigned low 64 bits; negative values use two's
// complement across the full 128 bits).
func bigIntToI128(v *big.Int) (xdr.Int128Parts, error) {
	if v == nil {
		return xdr.Int128Parts{}, fmt.Errorf("%w: amount is nil", ErrInvalidArgument)
	}
	if v.Cmp(minI128) < 0 || v.Cmp(maxI128) > 0 {
		return xdr.Int128Parts{}, fmt.Errorf("%w: amount %s is outside the i128 range", ErrInvalidArgument, v)
	}

	unsigned := new(big.Int).Set(v)
	if v.Sign() < 0 {
		unsigned.Add(unsigned, two128)
	}

	hi := new(big.Int).Rsh(unsigned, 64)
	lo := new(big.Int).And(unsigned, mask64)
	return xdr.Int128Parts{
		Hi: xdr.Int64(int64(hi.Uint64())),
		Lo: xdr.Uint64(lo.Uint64()),
	}, nil
}

// i128ToBigInt decodes Soroban Int128Parts into a signed big.Int.
func i128ToBigInt(parts xdr.Int128Parts) *big.Int {
	hi := new(big.Int).SetInt64(int64(parts.Hi))
	hi.Lsh(hi, 64)
	lo := new(big.Int).SetUint64(uint64(parts.Lo))
	return hi.Add(hi, lo)
}

func scvBool(v bool) xdr.ScVal {
	val, _ := xdr.NewScVal(xdr.ScValTypeScvBool, v)
	return val
}

func scvU32(v uint32) xdr.ScVal {
	val, _ := xdr.NewScVal(xdr.ScValTypeScvU32, xdr.Uint32(v))
	return val
}

func scvU64(v uint64) xdr.ScVal {
	val, _ := xdr.NewScVal(xdr.ScValTypeScvU64, xdr.Uint64(v))
	return val
}

func scvI128(v *big.Int) (xdr.ScVal, error) {
	parts, err := bigIntToI128(v)
	if err != nil {
		return xdr.ScVal{}, err
	}
	return xdr.NewScVal(xdr.ScValTypeScvI128, parts)
}

func scvString(s string) xdr.ScVal {
	val, _ := xdr.NewScVal(xdr.ScValTypeScvString, xdr.ScString(s))
	return val
}

func scvSymbol(s string) xdr.ScVal {
	val, _ := xdr.NewScVal(xdr.ScValTypeScvSymbol, xdr.ScSymbol(s))
	return val
}

// scvStatus encodes an EscrowStatus the way the contract's unit enum is
// represented in Soroban: a one-element vec holding the variant name.
func scvStatus(s EscrowStatus) xdr.ScVal {
	return scvVec([]xdr.ScVal{scvSymbol(s.String())})
}

func scvBytes(b []byte) xdr.ScVal {
	val, _ := xdr.NewScVal(xdr.ScValTypeScvBytes, xdr.ScBytes(b))
	return val
}

func scvVoid() xdr.ScVal {
	val, _ := xdr.NewScVal(xdr.ScValTypeScvVoid, nil)
	return val
}

func scvVec(values []xdr.ScVal) xdr.ScVal {
	vec := xdr.ScVec(values)
	val, _ := xdr.NewScVal(xdr.ScValTypeScvVec, &vec)
	return val
}

func scvMap(entries []xdr.ScMapEntry) xdr.ScVal {
	m := xdr.ScMap(entries)
	val, _ := xdr.NewScVal(xdr.ScValTypeScvMap, &m)
	return val
}

func scvOptionU64(v *uint64) xdr.ScVal {
	if v == nil {
		return scvVoid()
	}
	return scvU64(*v)
}

func scvOptionString(v *string) xdr.ScVal {
	if v == nil {
		return scvVoid()
	}
	return scvString(*v)
}

func scvOptionAddress(v *string) (xdr.ScVal, error) {
	if v == nil {
		return scvVoid(), nil
	}
	return scvAddress(*v)
}

// parseScAddress converts a G... account address or C... contract address into
// an ScAddress.
func parseScAddress(address string) (xdr.ScAddress, error) {
	switch {
	case strings.HasPrefix(address, "G"):
		accountID, err := xdr.AddressToAccountId(address)
		if err != nil {
			return xdr.ScAddress{}, fmt.Errorf("%w: invalid account address %q: %v", ErrInvalidArgument, address, err)
		}
		return xdr.ScAddress{
			Type:      xdr.ScAddressTypeScAddressTypeAccount,
			AccountId: &accountID,
		}, nil
	case strings.HasPrefix(address, "C"):
		raw, err := strkey.Decode(strkey.VersionByteContract, address)
		if err != nil {
			return xdr.ScAddress{}, fmt.Errorf("%w: invalid contract address %q: %v", ErrInvalidArgument, address, err)
		}
		var contractID xdr.ContractId
		copy(contractID[:], raw)
		return xdr.ScAddress{
			Type:       xdr.ScAddressTypeScAddressTypeContract,
			ContractId: &contractID,
		}, nil
	default:
		return xdr.ScAddress{}, fmt.Errorf("%w: address %q must start with G or C", ErrInvalidArgument, address)
	}
}

func scvAddress(address string) (xdr.ScVal, error) {
	scAddress, err := parseScAddress(address)
	if err != nil {
		return xdr.ScVal{}, err
	}
	return xdr.NewScVal(xdr.ScValTypeScvAddress, scAddress)
}

func scAddressString(address xdr.ScAddress) (string, error) {
	s, err := address.String()
	if err != nil {
		return "", fmt.Errorf("escrow: decode address: %w", err)
	}
	return s, nil
}

func decodeAddress(v xdr.ScVal) (string, error) {
	if v.Type != xdr.ScValTypeScvAddress || v.Address == nil {
		return "", fmt.Errorf("escrow: expected address ScVal, got %s", v.Type)
	}
	return scAddressString(*v.Address)
}

func decodeU32(v xdr.ScVal) (uint32, error) {
	if v.Type != xdr.ScValTypeScvU32 || v.U32 == nil {
		return 0, fmt.Errorf("escrow: expected u32 ScVal, got %s", v.Type)
	}
	return uint32(*v.U32), nil
}

func decodeU64(v xdr.ScVal) (uint64, error) {
	if v.Type != xdr.ScValTypeScvU64 || v.U64 == nil {
		return 0, fmt.Errorf("escrow: expected u64 ScVal, got %s", v.Type)
	}
	return uint64(*v.U64), nil
}

func decodeOptionU64(v xdr.ScVal) (*uint64, error) {
	if v.Type == xdr.ScValTypeScvVoid {
		return nil, nil
	}
	decoded, err := decodeU64(v)
	if err != nil {
		return nil, err
	}
	return &decoded, nil
}

func decodeOptionString(v xdr.ScVal) (*string, error) {
	if v.Type == xdr.ScValTypeScvVoid {
		return nil, nil
	}
	decoded, err := decodeString(v)
	if err != nil {
		return nil, err
	}
	return &decoded, nil
}

// decodeOptionAddress decodes an Optional<Address> field. The contract stores
// address-backed options as ScvVoid when absent and ScvAddress otherwise.
func decodeOptionAddress(v xdr.ScVal) (*string, error) {
	if v.Type == xdr.ScValTypeScvVoid {
		return nil, nil
	}
	decoded, err := decodeAddress(v)
	if err != nil {
		return nil, err
	}
	return &decoded, nil
}

func decodeString(v xdr.ScVal) (string, error) {
	if v.Type != xdr.ScValTypeScvString || v.Str == nil {
		return "", fmt.Errorf("escrow: expected string ScVal, got %s", v.Type)
	}
	return string(*v.Str), nil
}

func decodeBool(v xdr.ScVal) (bool, error) {
	if v.Type != xdr.ScValTypeScvBool || v.B == nil {
		return false, fmt.Errorf("escrow: expected bool ScVal, got %s", v.Type)
	}
	return *v.B, nil
}

func decodeI128(v xdr.ScVal) (*big.Int, error) {
	if v.Type != xdr.ScValTypeScvI128 || v.I128 == nil {
		return nil, fmt.Errorf("escrow: expected i128 ScVal, got %s", v.Type)
	}
	return i128ToBigInt(*v.I128), nil
}

func decodeVec(v xdr.ScVal) ([]xdr.ScVal, error) {
	if v.Type != xdr.ScValTypeScvVec || v.Vec == nil {
		return nil, fmt.Errorf("escrow: expected vec ScVal, got %s", v.Type)
	}
	if *v.Vec == nil {
		return nil, nil
	}
	return []xdr.ScVal(**v.Vec), nil
}

func decodeMap(v xdr.ScVal) (map[string]xdr.ScVal, error) {
	if v.Type != xdr.ScValTypeScvMap || v.Map == nil {
		return nil, fmt.Errorf("escrow: expected map ScVal, got %s", v.Type)
	}
	fields := make(map[string]xdr.ScVal)
	if *v.Map == nil {
		return fields, nil
	}
	for _, entry := range **v.Map {
		if entry.Key.Type != xdr.ScValTypeScvSymbol || entry.Key.Sym == nil {
			return nil, fmt.Errorf("escrow: expected symbol map key, got %s", entry.Key.Type)
		}
		fields[string(*entry.Key.Sym)] = entry.Val
	}
	return fields, nil
}

// decodeStatus decodes the contract's EscrowStatus enum. Soroban encodes a
// unit enum variant as a one-element vec holding the variant name, e.g.
// ScvVec([ScvSymbol("Funded")]), not as a bare integer.
func decodeStatus(v xdr.ScVal) (EscrowStatus, error) {
	if v.Type != xdr.ScValTypeScvVec || v.Vec == nil || *v.Vec == nil {
		return 0, fmt.Errorf("escrow: expected EscrowStatus enum ScVal, got %s", v.Type)
	}
	variants := **v.Vec
	if len(variants) != 1 || variants[0].Type != xdr.ScValTypeScvSymbol || variants[0].Sym == nil {
		return 0, fmt.Errorf("escrow: malformed EscrowStatus enum ScVal")
	}
	switch name := string(*variants[0].Sym); name {
	case "Funded":
		return EscrowStatusFunded, nil
	case "Released":
		return EscrowStatusReleased, nil
	case "Refunded":
		return EscrowStatusRefunded, nil
	default:
		return 0, fmt.Errorf("escrow: unknown EscrowStatus variant %q", name)
	}
}

// decodeEscrow decodes the contracttype EscrowData struct from an ScVal map.
func decodeEscrow(v xdr.ScVal) (Escrow, error) {
	fields, err := decodeMap(v)
	if err != nil {
		return Escrow{}, err
	}

	required := func(name string) (xdr.ScVal, error) {
		field, ok := fields[name]
		if !ok {
			return xdr.ScVal{}, fmt.Errorf("escrow: EscrowData missing field %q", name)
		}
		return field, nil
	}

	var result Escrow
	decodeField := func(name string, target any) error {
		field, err := required(name)
		if err != nil {
			return err
		}
		switch t := target.(type) {
		case *string:
			*t, err = decodeString(field)
		case *EscrowStatus:
			*t, err = decodeStatus(field)
		case **big.Int:
			*t, err = decodeI128(field)
		case *bool:
			*t, err = decodeBool(field)
		case *uint32:
			*t, err = decodeU32(field)
		case **uint64:
			*t, err = decodeOptionU64(field)
		default:
			return fmt.Errorf("escrow: internal decode target %T unsupported", target)
		}
		return err
	}

	payer, err := required("payer")
	if err != nil {
		return Escrow{}, err
	}
	if result.Payer, err = decodeAddress(payer); err != nil {
		return Escrow{}, err
	}
	payee, err := required("payee")
	if err != nil {
		return Escrow{}, err
	}
	if result.Payee, err = decodeAddress(payee); err != nil {
		return Escrow{}, err
	}
	token, err := required("token")
	if err != nil {
		return Escrow{}, err
	}
	if result.Token, err = decodeAddress(token); err != nil {
		return Escrow{}, err
	}
	if err := decodeField("amount", &result.Amount); err != nil {
		return Escrow{}, err
	}
	if err := decodeField("condition_ref", &result.ConditionRef); err != nil {
		return Escrow{}, err
	}
	if err := decodeField("status", &result.Status); err != nil {
		return Escrow{}, err
	}
	if err := decodeField("threshold", &result.Threshold); err != nil {
		return Escrow{}, err
	}
	if err := decodeField("refund_after", &result.RefundAfter); err != nil {
		return Escrow{}, err
	}
	// refund_to was added after the original EscrowData layout. The contract
	// stores it as an Address, so decode it as an address-backed option.
	if field, ok := fields["refund_to"]; ok {
		decoded, err := decodeOptionAddress(field)
		if err != nil {
			return Escrow{}, err
		}
		result.RefundTo = decoded
	}
	// release_not_before was added after the original EscrowData layout. Decode when present.
	if field, ok := fields["release_not_before"]; ok {
		decoded, err := decodeOptionU64(field)
		if err != nil {
			return Escrow{}, err
		}
		result.ReleaseNotBefore = decoded
	}
	if err := decodeField("notify_payee", &result.NotifyPayee); err != nil {
		return Escrow{}, err
	}

	releasersVal, err := required("releasers")
	if err != nil {
		return Escrow{}, err
	}
	releaserVals, err := decodeVec(releasersVal)
	if err != nil {
		return Escrow{}, err
	}
	result.Releasers = make([]string, 0, len(releaserVals))
	for _, rv := range releaserVals {
		releaser, err := decodeAddress(rv)
		if err != nil {
			return Escrow{}, err
		}
		result.Releasers = append(result.Releasers, releaser)
	}

	// These two fields were added after the original EscrowData layout. Decode
	// them when present so the client also understands current deployments.
	if field, ok := fields["requires_acceptance"]; ok {
		decoded, err := decodeBool(field)
		if err != nil {
			return Escrow{}, err
		}
		result.RequiresAcceptance = decoded
	}
	if field, ok := fields["accepted_at"]; ok {
		decoded, err := decodeOptionU64(field)
		if err != nil {
			return Escrow{}, err
		}
		result.AcceptedAt = decoded
	}

	return result, nil
}

// escrowDataScVal is the inverse of decodeEscrow. It is used by unit tests today
// and keeps the field names/order in one place if the contract gains a client
// helper later.
func escrowDataScVal(e Escrow) (xdr.ScVal, error) {
	amount, err := scvI128(e.Amount)
	if err != nil {
		return xdr.ScVal{}, err
	}
	releasers := make([]xdr.ScVal, 0, len(e.Releasers))
	for _, releaser := range e.Releasers {
		value, err := scvAddress(releaser)
		if err != nil {
			return xdr.ScVal{}, err
		}
		releasers = append(releasers, value)
	}
	payer, err := scvAddress(e.Payer)
	if err != nil {
		return xdr.ScVal{}, err
	}
	payee, err := scvAddress(e.Payee)
	if err != nil {
		return xdr.ScVal{}, err
	}
	token, err := scvAddress(e.Token)
	if err != nil {
		return xdr.ScVal{}, err
	}
	refundTo, err := scvOptionAddress(e.RefundTo)
	if err != nil {
		return xdr.ScVal{}, err
	}
	return scvMap([]xdr.ScMapEntry{
		{Key: scvSymbol("payer"), Val: payer},
		{Key: scvSymbol("payee"), Val: payee},
		{Key: scvSymbol("token"), Val: token},
		{Key: scvSymbol("amount"), Val: amount},
		{Key: scvSymbol("condition_ref"), Val: scvString(e.ConditionRef)},
		{Key: scvSymbol("status"), Val: scvStatus(e.Status)},
		{Key: scvSymbol("releasers"), Val: scvVec(releasers)},
		{Key: scvSymbol("threshold"), Val: scvU32(e.Threshold)},
		{Key: scvSymbol("refund_after"), Val: scvOptionU64(e.RefundAfter)},
		{Key: scvSymbol("refund_to"), Val: refundTo},
		{Key: scvSymbol("release_not_before"), Val: scvOptionU64(e.ReleaseNotBefore)},
		{Key: scvSymbol("notify_payee"), Val: scvBool(e.NotifyPayee)},
		{Key: scvSymbol("requires_acceptance"), Val: scvBool(e.RequiresAcceptance)},
		{Key: scvSymbol("accepted_at"), Val: scvOptionU64(e.AcceptedAt)},
	}), nil
}
