package escrow

import (
	"math/big"
	"reflect"
	"strings"
	"testing"

	"github.com/stellar/go-stellar-sdk/keypair"
	"github.com/stellar/go-stellar-sdk/xdr"
)

const testContractID = "CAHQ4J3T23WSIBBG6SI6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEV5"

func TestI128RoundTripBoundaries(t *testing.T) {
	max := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 127), big.NewInt(1))
	min := new(big.Int).Neg(new(big.Int).Lsh(big.NewInt(1), 127))
	values := []*big.Int{
		big.NewInt(0),
		big.NewInt(1),
		big.NewInt(-1),
		big.NewInt(1 << 40),
		new(big.Int).Lsh(big.NewInt(1), 64),
		new(big.Int).Neg(new(big.Int).Lsh(big.NewInt(1), 64)),
		max,
		min,
		new(big.Int).Sub(max, big.NewInt(1)),
		new(big.Int).Add(min, big.NewInt(1)),
	}

	for _, value := range values {
		parts, err := bigIntToI128(value)
		if err != nil {
			t.Fatalf("bigIntToI128(%s): %v", value, err)
		}
		decoded := i128ToBigInt(parts)
		if decoded.Cmp(value) != 0 {
			t.Fatalf("round trip %s: got %s (hi=%d lo=%d)", value, decoded, parts.Hi, parts.Lo)
		}
	}
}

func TestI128RejectsOutOfRange(t *testing.T) {
	max := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 127), big.NewInt(1))
	min := new(big.Int).Neg(new(big.Int).Lsh(big.NewInt(1), 127))

	for _, value := range []*big.Int{
		new(big.Int).Add(max, big.NewInt(1)),
		new(big.Int).Sub(min, big.NewInt(1)),
	} {
		if _, err := bigIntToI128(value); err == nil {
			t.Fatalf("bigIntToI128(%s) accepted an out-of-range value", value)
		}
	}
	if _, err := bigIntToI128(nil); err == nil {
		t.Fatal("bigIntToI128(nil) accepted a nil amount")
	}
}

func TestI128KnownEncodings(t *testing.T) {
	one, err := bigIntToI128(big.NewInt(1))
	if err != nil {
		t.Fatal(err)
	}
	if one.Hi != 0 || one.Lo != 1 {
		t.Fatalf("1 encoded as hi=%d lo=%d", one.Hi, one.Lo)
	}

	minusOne, err := bigIntToI128(big.NewInt(-1))
	if err != nil {
		t.Fatal(err)
	}
	if int64(minusOne.Hi) != -1 || uint64(minusOne.Lo) != ^uint64(0) {
		t.Fatalf("-1 encoded as hi=%d lo=%d", minusOne.Hi, minusOne.Lo)
	}

	two64 := new(big.Int).Lsh(big.NewInt(1), 64)
	encoded, err := bigIntToI128(two64)
	if err != nil {
		t.Fatal(err)
	}
	if encoded.Hi != 1 || encoded.Lo != 0 {
		t.Fatalf("2^64 encoded as hi=%d lo=%d", encoded.Hi, encoded.Lo)
	}
}

func TestAddressScValRoundTrip(t *testing.T) {
	account := keypair.MustRandom().Address()
	for _, address := range []string{account, testContractID} {
		value, err := scvAddress(address)
		if err != nil {
			t.Fatalf("scvAddress(%s): %v", address, err)
		}
		decoded, err := decodeAddress(value)
		if err != nil {
			t.Fatalf("decodeAddress(%s): %v", address, err)
		}
		if decoded != address {
			t.Fatalf("address round trip: got %q want %q", decoded, address)
		}
	}
}

func TestAddressRejectsInvalid(t *testing.T) {
	for _, address := range []string{"", "GNOTANADDRESS", "CNOTANADDRESS", "X123"} {
		if _, err := scvAddress(address); err == nil {
			t.Fatalf("scvAddress(%q) succeeded", address)
		}
	}
}

func TestPrimitiveScValRoundTrip(t *testing.T) {
	t.Run("u64", func(t *testing.T) {
		got, err := decodeU64(scvU64(42))
		if err != nil || got != 42 {
			t.Fatalf("decodeU64: got %d, %v", got, err)
		}
	})
	t.Run("u32", func(t *testing.T) {
		got, err := decodeU32(scvU32(3))
		if err != nil || got != 3 {
			t.Fatalf("decodeU32: got %d, %v", got, err)
		}
	})
	t.Run("string", func(t *testing.T) {
		got, err := decodeString(scvString("opaque-ref"))
		if err != nil || got != "opaque-ref" {
			t.Fatalf("decodeString: got %q, %v", got, err)
		}
	})
	t.Run("bool", func(t *testing.T) {
		got, err := decodeBool(scvBool(true))
		if err != nil || !got {
			t.Fatalf("decodeBool: got %v, %v", got, err)
		}
	})
	t.Run("option none", func(t *testing.T) {
		got, err := decodeOptionU64(scvOptionU64(nil))
		if err != nil || got != nil {
			t.Fatalf("decodeOptionU64(nil): got %v, %v", got, err)
		}
	})
	t.Run("option some", func(t *testing.T) {
		deadline := uint64(1_900_000_000)
		got, err := decodeOptionU64(scvOptionU64(&deadline))
		if err != nil || got == nil || *got != deadline {
			t.Fatalf("decodeOptionU64: got %v, %v", got, err)
		}
	})
	t.Run("vec", func(t *testing.T) {
		values, err := decodeVec(scvVec([]xdr.ScVal{scvU64(1), scvU64(2)}))
		if err != nil || len(values) != 2 {
			t.Fatalf("decodeVec: got %d values, %v", len(values), err)
		}
	})
	t.Run("map", func(t *testing.T) {
		fields, err := decodeMap(scvMap([]xdr.ScMapEntry{
			{Key: scvSymbol("a"), Val: scvU64(1)},
			{Key: scvSymbol("b"), Val: scvString("two")},
		}))
		if err != nil {
			t.Fatal(err)
		}
		if len(fields) != 2 {
			t.Fatalf("decodeMap: got %d fields", len(fields))
		}
	})
}

func TestDecodeEscrowData(t *testing.T) {
	payer := keypair.MustRandom().Address()
	payee := keypair.MustRandom().Address()
	releaserA := keypair.MustRandom().Address()
	releaserB := keypair.MustRandom().Address()
	refundAfter := uint64(1_912_000_000)
	acceptedAt := uint64(1_911_000_000)
	amount := new(big.Int).Add(new(big.Int).Lsh(big.NewInt(1), 100), big.NewInt(12345))

	want := Escrow{
		Payer:              payer,
		Payee:              payee,
		Token:              testContractID,
		Amount:             amount,
		ConditionRef:       "invoice-42",
		Releasers:          []string{releaserA, releaserB},
		Threshold:          2,
		RefundAfter:        &refundAfter,
		NotifyPayee:        true,
		Status:             EscrowStatusFunded,
		RequiresAcceptance: true,
		AcceptedAt:         &acceptedAt,
	}

	encoded, err := escrowDataScVal(want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := decodeEscrow(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("decoded escrow mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestDecodeEscrowDataWithoutOptionalFields(t *testing.T) {
	encoded := scvMap([]xdr.ScMapEntry{
		{Key: scvSymbol("payer"), Val: mustAddress(t, keypair.MustRandom().Address())},
		{Key: scvSymbol("payee"), Val: mustAddress(t, keypair.MustRandom().Address())},
		{Key: scvSymbol("token"), Val: mustAddress(t, testContractID)},
		{Key: scvSymbol("amount"), Val: mustI128(t, big.NewInt(7))},
		{Key: scvSymbol("condition_ref"), Val: scvString("")},
		{Key: scvSymbol("status"), Val: scvStatus(EscrowStatusReleased)},
		{Key: scvSymbol("releasers"), Val: scvVec([]xdr.ScVal{mustAddress(t, keypair.MustRandom().Address())})},
		{Key: scvSymbol("threshold"), Val: scvU32(1)},
		{Key: scvSymbol("refund_after"), Val: scvVoid()},
		{Key: scvSymbol("notify_payee"), Val: scvBool(false)},
	})
	got, err := decodeEscrow(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if got.RefundAfter != nil || got.AcceptedAt != nil || got.RequiresAcceptance {
		t.Fatalf("optional fields decoded as present: %#v", got)
	}
	if got.Status != EscrowStatusReleased || got.Amount.Cmp(big.NewInt(7)) != 0 {
		t.Fatalf("unexpected escrow: %#v", got)
	}
}

func TestDecodeEscrowDataRejectsMissingField(t *testing.T) {
	_, err := decodeEscrow(scvMap(nil))
	if err == nil {
		t.Fatal("decodeEscrow accepted an empty map")
	}
	if !strings.Contains(err.Error(), "missing field") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func mustAddress(t *testing.T, address string) xdr.ScVal {
	t.Helper()
	value, err := scvAddress(address)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func mustI128(t *testing.T, value *big.Int) xdr.ScVal {
	t.Helper()
	encoded, err := scvI128(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
