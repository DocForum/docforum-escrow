package escrow

import (
	"errors"
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
	refundTo := payer
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
		RefundTo:           &refundTo,
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

func TestDecodeEscrowDataRefundToIsAddress(t *testing.T) {
	// The contract stores refund_to as an Address, not a string. Build the map
	// by hand so the decoder is exercised against the contract's encoding
	// rather than the SDK's own inverse helper.
	refundTo := keypair.MustRandom().Address()
	encoded := scvMap([]xdr.ScMapEntry{
		{Key: scvSymbol("payer"), Val: mustAddress(t, keypair.MustRandom().Address())},
		{Key: scvSymbol("payee"), Val: mustAddress(t, keypair.MustRandom().Address())},
		{Key: scvSymbol("token"), Val: mustAddress(t, testContractID)},
		{Key: scvSymbol("amount"), Val: mustI128(t, big.NewInt(1))},
		{Key: scvSymbol("condition_ref"), Val: scvString("ref")},
		{Key: scvSymbol("status"), Val: scvStatus(EscrowStatusFunded)},
		{Key: scvSymbol("releasers"), Val: scvVec([]xdr.ScVal{mustAddress(t, keypair.MustRandom().Address())})},
		{Key: scvSymbol("threshold"), Val: scvU32(1)},
		{Key: scvSymbol("refund_after"), Val: scvVoid()},
		{Key: scvSymbol("refund_to"), Val: mustAddress(t, refundTo)},
		{Key: scvSymbol("notify_payee"), Val: scvBool(false)},
	})
	got, err := decodeEscrow(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if got.RefundTo == nil || *got.RefundTo != refundTo {
		t.Fatalf("refund_to = %v, want %q", got.RefundTo, refundTo)
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

func TestDecodePooledData(t *testing.T) {
	target := new(big.Int).Add(new(big.Int).Lsh(big.NewInt(1), 90), big.NewInt(7))
	encoded := scvMap([]xdr.ScMapEntry{
		{Key: scvSymbol("funding_target"), Val: mustI128(t, target)},
		{Key: scvSymbol("funding_deadline"), Val: scvU64(1_912_000_000)},
	})
	got, err := decodePooledData(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if got.FundingTarget.Cmp(target) != 0 {
		t.Fatalf("funding target = %s, want %s", got.FundingTarget, target)
	}
	if got.FundingDeadline != 1_912_000_000 {
		t.Fatalf("funding deadline = %d", got.FundingDeadline)
	}

	if _, err := decodePooledData(scvMap([]xdr.ScMapEntry{
		{Key: scvSymbol("funding_target"), Val: mustI128(t, big.NewInt(1))},
	})); err == nil {
		t.Fatal("decodePooledData accepted a record without funding_deadline")
	}
}

func TestDecodePooledDataReleaseDeadline(t *testing.T) {
	base := []xdr.ScMapEntry{
		{Key: scvSymbol("funding_target"), Val: mustI128(t, big.NewInt(1_000))},
		{Key: scvSymbol("funding_deadline"), Val: scvU64(1_912_000_000)},
	}

	// A deployment that predates issue #288 has no release_deadline field.
	legacy, err := decodePooledData(scvMap(base))
	if err != nil {
		t.Fatal(err)
	}
	if legacy.ReleaseDeadline != nil {
		t.Fatalf("legacy release deadline = %d, want nil", *legacy.ReleaseDeadline)
	}

	// Current deployments always send the field: None is void.
	none, err := decodePooledData(scvMap(append(append([]xdr.ScMapEntry{}, base...),
		xdr.ScMapEntry{Key: scvSymbol("release_deadline"), Val: scvVoid()})))
	if err != nil {
		t.Fatal(err)
	}
	if none.ReleaseDeadline != nil {
		t.Fatalf("None release deadline = %d, want nil", *none.ReleaseDeadline)
	}

	some, err := decodePooledData(scvMap(append(append([]xdr.ScMapEntry{}, base...),
		xdr.ScMapEntry{Key: scvSymbol("release_deadline"), Val: scvU64(1_913_000_000)})))
	if err != nil {
		t.Fatal(err)
	}
	if some.ReleaseDeadline == nil || *some.ReleaseDeadline != 1_913_000_000 {
		t.Fatalf("release deadline = %v, want 1913000000", some.ReleaseDeadline)
	}

	if _, err := decodePooledData(scvMap(append(append([]xdr.ScMapEntry{}, base...),
		xdr.ScMapEntry{Key: scvSymbol("release_deadline"), Val: scvString("soon")}))); err == nil {
		t.Fatal("decodePooledData accepted a non-u64 release_deadline")
	}
}

func TestDecodeContributionAndOption(t *testing.T) {
	encoded := scvMap([]xdr.ScMapEntry{
		{Key: scvSymbol("amount"), Val: mustI128(t, big.NewInt(650_000))},
		{Key: scvSymbol("refunded"), Val: scvBool(true)},
	})
	got, err := decodeContribution(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if got.Amount.Cmp(big.NewInt(650_000)) != 0 || !got.Refunded {
		t.Fatalf("contribution = %#v", got)
	}

	// get_contribution returns Option<Contribution>: None is ScvVoid.
	none, err := decodeOptionContribution(scvVoid())
	if err != nil {
		t.Fatal(err)
	}
	if none != nil {
		t.Fatalf("None decoded as %#v", none)
	}
	some, err := decodeOptionContribution(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if some == nil || some.Amount.Cmp(big.NewInt(650_000)) != 0 || !some.Refunded {
		t.Fatalf("Some decoded as %#v", some)
	}
}

func TestDecodeSettleResults(t *testing.T) {
	unauthorized, err := scvContractError(3)
	if err != nil {
		t.Fatal(err)
	}
	notFunded, err := scvContractError(4)
	if err != nil {
		t.Fatal(err)
	}
	// settle_many returns Vec<Result<(), Error>>: Ok(()) is ScvVoid and Err
	// is an SCV_ERROR with the contract's code, so order is preserved and
	// every rejection is a typed *ContractError.
	results, err := decodeSettleResults(scvVec([]xdr.ScVal{
		scvVoid(),
		unauthorized,
		scvVoid(),
		notFunded,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 4 {
		t.Fatalf("results = %d, want 4", len(results))
	}
	if results[0] != nil || results[2] != nil {
		t.Fatalf("Ok(()) decoded as %v", results[0])
	}
	if !errors.Is(results[1], ErrUnauthorized) {
		t.Fatalf("result 1 = %v, want ErrUnauthorized", results[1])
	}
	if !errors.Is(results[3], ErrNotFunded) {
		t.Fatalf("result 3 = %v, want ErrNotFunded", results[3])
	}

	if _, err := decodeSettleResults(scvVec([]xdr.ScVal{scvU64(1)})); err == nil {
		t.Fatal("decodeSettleResults accepted a non-Void, non-error element")
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

func makeEventSnapshot(t *testing.T, withFee bool) xdr.ScVal {
	t.Helper()
	payer := keypair.MustRandom().Address()
	payee := keypair.MustRandom().Address()
	token := testContractID
	releaser := keypair.MustRandom().Address()
	feeRecipient := keypair.MustRandom().Address()
	refundAfter := uint64(1_912_000_000)
	acceptedAt := uint64(1_911_000_000)
	amount := big.NewInt(300)
	feeBps := uint32(100)

	fields := []xdr.ScVal{
		mustAddress(t, payer),
		mustAddress(t, payee),
		mustAddress(t, token),
		mustI128(t, amount),
		scvString("invoice-42"),
		scvVec([]xdr.ScVal{mustAddress(t, releaser)}),
		scvU32(1),
		scvOptionU64(&refundAfter),
		scvBool(true),
		scvBool(true),
		scvOptionU64(&acceptedAt),
		scvStatus(EscrowStatusReleased),
	}
	if withFee {
		fields = append(fields, scvVec([]xdr.ScVal{
			mustAddress(t, feeRecipient),
			scvU32(feeBps),
		}))
	}
	return scvVec(fields)
}

func TestDecodeEventSnapshotThirteenFields(t *testing.T) {
	snap := makeEventSnapshot(t, true)
	got, err := decodeEventSnapshot(&snap)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != EscrowStatusReleased {
		t.Fatalf("unexpected status: %v", got.Status)
	}
	if got.Amount == nil || got.Amount.Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("unexpected amount: %v", got.Amount)
	}
	if got.FeeRecipient == nil || *got.FeeRecipient == "" {
		t.Fatal("fee recipient missing")
	}
	if got.FeeBps == nil || *got.FeeBps != 100 {
		t.Fatalf("unexpected fee bps: %v", got.FeeBps)
	}
	if len(got.Releasers) != 1 {
		t.Fatalf("unexpected releasers: %v", got.Releasers)
	}
	if !got.NotifyPayee || !got.RequiresAcceptance {
		t.Fatalf("unexpected flags: %#v", got)
	}
	if got.RefundAfter == nil || *got.RefundAfter != 1_912_000_000 {
		t.Fatalf("unexpected refund after: %v", got.RefundAfter)
	}
	if got.AcceptedAt == nil || *got.AcceptedAt != 1_911_000_000 {
		t.Fatalf("unexpected accepted at: %v", got.AcceptedAt)
	}
}

func TestDecodeEventSnapshotTwelveFields(t *testing.T) {
	snap := makeEventSnapshot(t, false)
	got, err := decodeEventSnapshot(&snap)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != EscrowStatusReleased {
		t.Fatalf("unexpected status: %v", got.Status)
	}
	if got.FeeRecipient != nil {
		t.Fatalf("expected no fee recipient, got %v", got.FeeRecipient)
	}
	if got.FeeBps != nil {
		t.Fatalf("expected no fee bps, got %v", got.FeeBps)
	}
}

func TestDecodeEventSnapshotRejectsShort(t *testing.T) {
	_, err := decodeEventSnapshot(&xdr.ScVal{Type: xdr.ScValTypeScvVec})
	if err == nil {
		t.Fatal("decodeEventSnapshot accepted an empty snapshot")
	}
}

func TestDecodeEventSnapshotRejectsUnknownShape(t *testing.T) {
	if _, err := decodeEventSnapshot(&xdr.ScVal{Type: xdr.ScValTypeScvBool}); err == nil {
		t.Fatal("decodeEventSnapshot accepted a non-vec value")
	}
}
