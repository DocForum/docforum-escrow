package escrow

import (
	"context"
	"errors"
	"math/big"
	"testing"

	"github.com/stellar/go-stellar-sdk/keypair"
	"github.com/stellar/go-stellar-sdk/network"
	"github.com/stellar/go-stellar-sdk/txnbuild"
	"github.com/stellar/go-stellar-sdk/xdr"
)

func TestNewValidatesConfig(t *testing.T) {
	if _, err := New(Config{}); !errors.Is(err, ErrInvalidContractID) {
		t.Fatalf("empty contract id error = %v", err)
	}
	if _, err := New(Config{ContractID: "GNOTACONTRACT"}); !errors.Is(err, ErrInvalidContractID) {
		t.Fatalf("invalid contract id error = %v", err)
	}
	if _, err := New(Config{ContractID: testContractID, NetworkPassphrase: network.PublicNetworkPassphrase}); !errors.Is(err, ErrNetworkMismatch) {
		t.Fatalf("mainnet error = %v", err)
	}
	if _, err := New(Config{ContractID: testContractID, RPCURL: "://bad"}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("bad rpc url error = %v", err)
	}

	client, err := New(Config{ContractID: testContractID})
	if err != nil {
		t.Fatal(err)
	}
	if client.ContractID() != testContractID {
		t.Fatalf("ContractID() = %q", client.ContractID())
	}
	if client.networkPassphrase != network.TestNetworkPassphrase {
		t.Fatalf("default passphrase = %q", client.networkPassphrase)
	}

	if _, err := client.GetStatus(context.Background(), 1); !errors.Is(err, ErrSignerRequired) {
		t.Fatalf("GetStatus without signer error = %v", err)
	}
}

func TestKeypairSignerSignsEnvelope(t *testing.T) {
	kp := keypair.MustRandom()
	signer, err := NewKeypairSigner(kp.Seed(), network.TestNetworkPassphrase)
	if err != nil {
		t.Fatal(err)
	}
	if signer.Address() != kp.Address() {
		t.Fatalf("Address() = %q, want %q", signer.Address(), kp.Address())
	}

	contractAddress, err := parseScAddress(testContractID)
	if err != nil {
		t.Fatal(err)
	}
	op := txnbuild.InvokeHostFunction{
		HostFunction: xdr.HostFunction{
			Type: xdr.HostFunctionTypeHostFunctionTypeInvokeContract,
			InvokeContract: &xdr.InvokeContractArgs{
				ContractAddress: contractAddress,
				FunctionName:    "get_status",
				Args:            []xdr.ScVal{scvU64(1)},
			},
		},
	}
	tx, err := txnbuild.NewTransaction(txnbuild.TransactionParams{
		SourceAccount:        &txnbuild.SimpleAccount{AccountID: kp.Address(), Sequence: 1},
		IncrementSequenceNum: true,
		Operations:           []txnbuild.Operation{&op},
		BaseFee:              txnbuild.MinBaseFee,
		Preconditions:        txnbuild.Preconditions{TimeBounds: txnbuild.NewTimeout(30)},
	})
	if err != nil {
		t.Fatal(err)
	}
	unsigned, err := tx.Base64()
	if err != nil {
		t.Fatal(err)
	}
	signed, err := signer.SignTransaction(context.Background(), unsigned)
	if err != nil {
		t.Fatal(err)
	}

	var envelope xdr.TransactionEnvelope
	if err := xdr.SafeUnmarshalBase64(signed, &envelope); err != nil {
		t.Fatal(err)
	}
	if len(envelope.V1.Signatures) != 1 {
		t.Fatalf("signatures = %d, want 1", len(envelope.V1.Signatures))
	}
	hash, err := network.HashTransactionInEnvelope(envelope, network.TestNetworkPassphrase)
	if err != nil {
		t.Fatal(err)
	}
	if err := kp.Verify(hash[:], envelope.V1.Signatures[0].Signature); err != nil {
		t.Fatalf("signature verification failed: %v", err)
	}
}

func TestCreateEscrowArgsSingleReleaser(t *testing.T) {
	payer := keypair.MustRandom().Address()
	payee := keypair.MustRandom().Address()
	releaser := keypair.MustRandom().Address()
	amount := big.NewInt(12_345_678)
	deadline := uint64(1_900_000_000)
	refundTo := keypair.MustRandom().Address()

	args, err := createEscrowArgs(payer, payee, testContractID, amount, "ref-1", []string{releaser}, 1, &deadline, &refundTo, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 11 {
		t.Fatalf("arg count = %d, want 11", len(args))
	}
	decodedAmount, err := decodeI128(args[3])
	if err != nil || decodedAmount.Cmp(amount) != 0 {
		t.Fatalf("amount arg = %v, %v", decodedAmount, err)
	}
	if decoded, err := decodeString(args[4]); err != nil || decoded != "ref-1" {
		t.Fatalf("condition ref = %q, %v", decoded, err)
	}
	if decoded, err := decodeAddress(args[5]); err != nil || decoded != releaser {
		t.Fatalf("releaser = %q, %v", decoded, err)
	}
	if decoded, err := decodeOptionU64(args[6]); err != nil || decoded == nil || *decoded != deadline {
		t.Fatalf("refund after = %v, %v", decoded, err)
	}
	if decoded, err := decodeBool(args[7]); err != nil || !decoded {
		t.Fatalf("notify payee = %v, %v", decoded, err)
	}
	if decoded, err := decodeOptionAddress(args[8]); err != nil || decoded == nil || *decoded != refundTo {
		t.Fatalf("refund to = %v, %v", decoded, err)
	}
}

func TestCreateEscrowArgsQuorum(t *testing.T) {
	payer := keypair.MustRandom().Address()
	payee := keypair.MustRandom().Address()
	releasers := []string{keypair.MustRandom().Address(), keypair.MustRandom().Address()}
	args, err := createEscrowArgs(payer, payee, testContractID, big.NewInt(1), "", releasers, 2, nil, nil, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 10 {
		t.Fatalf("arg count = %d, want 10", len(args))
	}
	values, err := decodeVec(args[5])
	if err != nil || len(values) != 2 {
		t.Fatalf("releasers = %d, %v", len(values), err)
	}
	if threshold, err := decodeU32(args[6]); err != nil || threshold != 2 {
		t.Fatalf("threshold = %d, %v", threshold, err)
	}
	if decoded, err := decodeOptionU64(args[7]); err != nil || decoded != nil {
		t.Fatalf("refund after = %v, %v", decoded, err)
	}
	if decoded, err := decodeBool(args[8]); err != nil || decoded {
		t.Fatalf("notify payee = %v, want false", decoded)
	}
	if decoded, err := decodeOptionAddress(args[9]); err != nil || decoded != nil {
		t.Fatalf("refund to = %v, %v", decoded, err)
	}
}

func TestCreateEscrowArgShape(t *testing.T) {
	payer := keypair.MustRandom().Address()
	payee := keypair.MustRandom().Address()
	releaser := keypair.MustRandom().Address()

	single, err := createEscrowArgs(payer, payee, testContractID, big.NewInt(1), "", []string{releaser}, 1, nil, nil, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(single) != 11 {
		t.Fatalf("create_escrow args = %d, want 11", len(single))
	}
	if single[9].Type != xdr.ScValTypeScvVoid || single[10].Type != xdr.ScValTypeScvVoid {
		t.Fatalf("create_escrow fee args have types %s/%s, want void/void (no fee)", single[9].Type, single[10].Type)
	}
	if single[5].Type != xdr.ScValTypeScvAddress {
		t.Fatalf("create_escrow releaser arg type = %s, want address", single[5].Type)
	}

	multi, err := createEscrowArgs(payer, payee, testContractID, big.NewInt(1), "", []string{releaser}, 1, nil, nil, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(multi) != 10 {
		t.Fatalf("create_escrow_with_releasers args = %d, want 10", len(multi))
	}
	if multi[5].Type != xdr.ScValTypeScvVec || multi[6].Type != xdr.ScValTypeScvU32 {
		t.Fatalf("with-releasers args have types %s/%s, want vec/u32", multi[5].Type, multi[6].Type)
	}
}

func TestCreateEscrowWithAcceptanceArgs(t *testing.T) {
	payer := keypair.MustRandom().Address()
	payee := keypair.MustRandom().Address()
	releaser := keypair.MustRandom().Address()
	refundTo := keypair.MustRandom().Address()
	deadline := uint64(1_900_000_000)
	amount := big.NewInt(42)

	args, err := createEscrowWithAcceptanceArgs(payer, payee, testContractID, amount, "accept-ref", releaser, &deadline, true, &refundTo)
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 9 {
		t.Fatalf("arg count = %d, want 9", len(args))
	}
	if got, err := decodeAddress(args[0]); err != nil || got != payer {
		t.Fatalf("payer = %q, %v", got, err)
	}
	if got, err := decodeAddress(args[1]); err != nil || got != payee {
		t.Fatalf("payee = %q, %v", got, err)
	}
	if got, err := decodeAddress(args[2]); err != nil || got != testContractID {
		t.Fatalf("token = %q, %v", got, err)
	}
	if got, err := decodeI128(args[3]); err != nil || got.Cmp(amount) != 0 {
		t.Fatalf("amount = %v, %v", got, err)
	}
	if got, err := decodeString(args[4]); err != nil || got != "accept-ref" {
		t.Fatalf("condition ref = %q, %v", got, err)
	}
	if got, err := decodeAddress(args[5]); err != nil || got != releaser {
		t.Fatalf("releaser = %q, %v", got, err)
	}
	if got, err := decodeOptionU64(args[6]); err != nil || got == nil || *got != deadline {
		t.Fatalf("refund after = %v, %v", got, err)
	}
	if got, err := decodeBool(args[7]); err != nil || !got {
		t.Fatalf("requires acceptance = %v, %v", got, err)
	}
	if got, err := decodeOptionAddress(args[8]); err != nil || got == nil || *got != refundTo {
		t.Fatalf("refund to = %v, %v", got, err)
	}
}

func TestAcceptCancelAndTransferPayeeArgs(t *testing.T) {
	payee := keypair.MustRandom().Address()
	newPayee := keypair.MustRandom().Address()

	accept, err := acceptArgs(77, payee)
	if err != nil {
		t.Fatal(err)
	}
	if len(accept) != 2 {
		t.Fatalf("accept arg count = %d, want 2", len(accept))
	}
	if got, err := decodeU64(accept[0]); err != nil || got != 77 {
		t.Fatalf("accept escrow id = %d, %v", got, err)
	}
	if got, err := decodeAddress(accept[1]); err != nil || got != payee {
		t.Fatalf("accept payee = %q, %v", got, err)
	}

	cancel, err := cancelArgs(77, payee)
	if err != nil {
		t.Fatal(err)
	}
	if len(cancel) != 2 {
		t.Fatalf("cancel arg count = %d, want 2", len(cancel))
	}
	if got, err := decodeAddress(cancel[1]); err != nil || got != payee {
		t.Fatalf("cancel payer = %q, %v", got, err)
	}

	transfer, err := transferPayeeArgs(77, payee, newPayee)
	if err != nil {
		t.Fatal(err)
	}
	if len(transfer) != 3 {
		t.Fatalf("transfer_payee arg count = %d, want 3", len(transfer))
	}
	if got, err := decodeAddress(transfer[1]); err != nil || got != payee {
		t.Fatalf("current payee = %q, %v", got, err)
	}
	if got, err := decodeAddress(transfer[2]); err != nil || got != newPayee {
		t.Fatalf("new payee = %q, %v", got, err)
	}

	if _, err := transferPayeeArgs(77, payee, "not-an-address"); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("invalid new payee error = %v", err)
	}
}

func TestCreatePooledEscrowArgs(t *testing.T) {
	creator := keypair.MustRandom().Address()
	payee := keypair.MustRandom().Address()
	releaser := keypair.MustRandom().Address()
	target := new(big.Int).Lsh(big.NewInt(1), 100)

	args, err := createPooledEscrowArgs(creator, payee, testContractID, target, "pool-1", releaser, 1_900_000_000)
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 7 {
		t.Fatalf("arg count = %d, want 7", len(args))
	}
	if got, err := decodeAddress(args[0]); err != nil || got != creator {
		t.Fatalf("creator = %q, %v", got, err)
	}
	if got, err := decodeAddress(args[1]); err != nil || got != payee {
		t.Fatalf("payee = %q, %v", got, err)
	}
	if got, err := decodeI128(args[3]); err != nil || got.Cmp(target) != 0 {
		t.Fatalf("funding target = %v, %v", got, err)
	}
	if got, err := decodeString(args[4]); err != nil || got != "pool-1" {
		t.Fatalf("condition ref = %q, %v", got, err)
	}
	if got, err := decodeAddress(args[5]); err != nil || got != releaser {
		t.Fatalf("releaser = %q, %v", got, err)
	}
	if got, err := decodeU64(args[6]); err != nil || got != 1_900_000_000 {
		t.Fatalf("funding deadline = %d, %v", got, err)
	}

	validation := []struct {
		name     string
		target   *big.Int
		deadline uint64
	}{
		{name: "nil target", target: nil, deadline: 1_900_000_000},
		{name: "zero target", target: big.NewInt(0), deadline: 1_900_000_000},
		{name: "over i128", target: new(big.Int).Add(maxI128, big.NewInt(1)), deadline: 1_900_000_000},
		{name: "no deadline", target: big.NewInt(1), deadline: 0},
	}
	for _, test := range validation {
		t.Run(test.name, func(t *testing.T) {
			if _, err := createPooledEscrowArgs(creator, payee, testContractID, test.target, "pool-1", releaser, test.deadline); !errors.Is(err, ErrInvalidArgument) {
				t.Fatalf("error = %v, want ErrInvalidArgument", err)
			}
		})
	}
}

func TestContributeAndClaimRefundArgs(t *testing.T) {
	contributor := keypair.MustRandom().Address()

	contribute, err := contributeArgs(5, contributor, big.NewInt(1_000))
	if err != nil {
		t.Fatal(err)
	}
	if len(contribute) != 3 {
		t.Fatalf("contribute arg count = %d, want 3", len(contribute))
	}
	if got, err := decodeU64(contribute[0]); err != nil || got != 5 {
		t.Fatalf("escrow id = %d, %v", got, err)
	}
	if got, err := decodeAddress(contribute[1]); err != nil || got != contributor {
		t.Fatalf("payer = %q, %v", got, err)
	}
	if got, err := decodeI128(contribute[2]); err != nil || got.Cmp(big.NewInt(1_000)) != 0 {
		t.Fatalf("amount = %v, %v", got, err)
	}
	for _, amount := range []*big.Int{nil, big.NewInt(0), big.NewInt(-1)} {
		if _, err := contributeArgs(5, contributor, amount); !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("amount %v error = %v, want ErrInvalidArgument", amount, err)
		}
	}

	claim, err := claimRefundArgs(5, contributor)
	if err != nil {
		t.Fatal(err)
	}
	if len(claim) != 2 {
		t.Fatalf("claim_refund arg count = %d, want 2", len(claim))
	}
	if got, err := decodeAddress(claim[1]); err != nil || got != contributor {
		t.Fatalf("contributor = %q, %v", got, err)
	}
}

func TestCreateEscrowsArgs(t *testing.T) {
	payer := keypair.MustRandom().Address()
	payees := []string{keypair.MustRandom().Address(), keypair.MustRandom().Address()}
	releaser := keypair.MustRandom().Address()
	deadline := uint64(1_900_000_000)

	args, err := createEscrowsArgs(payer, []CreateItem{
		{Payee: payees[0], Token: testContractID, Amount: big.NewInt(10), ConditionRef: "batch-1", Releaser: releaser},
		{Payee: payees[1], Token: testContractID, Amount: big.NewInt(20), ConditionRef: "batch-2", Releaser: releaser, RefundAfter: &deadline},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 2 {
		t.Fatalf("arg count = %d, want 2", len(args))
	}
	if got, err := decodeAddress(args[0]); err != nil || got != payer {
		t.Fatalf("payer = %q, %v", got, err)
	}
	items, err := decodeVec(args[1])
	if err != nil || len(items) != 2 {
		t.Fatalf("items = %d, %v", len(items), err)
	}
	for i, want := range []struct {
		payee  string
		amount int64
		ref    string
		refund *uint64
	}{
		{payee: payees[0], amount: 10, ref: "batch-1"},
		{payee: payees[1], amount: 20, ref: "batch-2", refund: &deadline},
	} {
		fields, err := decodeMap(items[i])
		if err != nil {
			t.Fatalf("item %d: %v", i, err)
		}
		if got, err := decodeAddress(fields["payee"]); err != nil || got != want.payee {
			t.Fatalf("item %d payee = %q, %v", i, got, err)
		}
		if got, err := decodeI128(fields["amount"]); err != nil || got.Cmp(big.NewInt(want.amount)) != 0 {
			t.Fatalf("item %d amount = %v, %v", i, got, err)
		}
		if got, err := decodeString(fields["condition_ref"]); err != nil || got != want.ref {
			t.Fatalf("item %d condition ref = %q, %v", i, got, err)
		}
		if got, err := decodeAddress(fields["releaser"]); err != nil || got != releaser {
			t.Fatalf("item %d releaser = %q, %v", i, got, err)
		}
		if got, err := decodeOptionU64(fields["refund_after"]); err != nil {
			t.Fatalf("item %d refund after: %v", i, err)
		} else if want.refund == nil && got != nil {
			t.Fatalf("item %d refund after = %v, want none", i, got)
		} else if want.refund != nil && (got == nil || *got != *want.refund) {
			t.Fatalf("item %d refund after = %v, want %d", i, got, *want.refund)
		}
	}

	// Every item is validated before encoding, so a bad item is rejected
	// instead of being sent.
	if _, err := createEscrowsArgs(payer, []CreateItem{{Payee: "GNOTANADDRESS", Token: testContractID, Amount: big.NewInt(1), Releaser: releaser}}); err == nil {
		t.Fatal("createEscrowsArgs accepted an invalid payee")
	}
	if _, err := createEscrowsArgs(payer, []CreateItem{{Payee: payees[0], Token: testContractID, Amount: big.NewInt(0), Releaser: releaser}}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("zero amount error = %v", err)
	}

	if MaxBatchSize != 16 || MaxSettleOps != 12 {
		t.Fatalf("limits = %d/%d, want 16/12 (contracts/escrow/src/constants.rs)", MaxBatchSize, MaxSettleOps)
	}
}

func TestSettleManyArgs(t *testing.T) {
	caller := keypair.MustRandom().Address()
	args, err := settleManyArgs(caller, []SettleOp{
		{EscrowID: 9, Action: SettleRelease},
		{EscrowID: 10, Action: SettleRefund},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 2 {
		t.Fatalf("arg count = %d, want 2", len(args))
	}
	if got, err := decodeAddress(args[0]); err != nil || got != caller {
		t.Fatalf("caller = %q, %v", got, err)
	}
	ops, err := decodeVec(args[1])
	if err != nil || len(ops) != 2 {
		t.Fatalf("ops = %d, %v", len(ops), err)
	}
	for i, want := range []struct {
		escrowID uint64
		action   string
	}{
		{escrowID: 9, action: "Release"},
		{escrowID: 10, action: "Refund"},
	} {
		tuple, err := decodeVec(ops[i])
		if err != nil || len(tuple) != 2 {
			t.Fatalf("op %d tuple = %d elements, %v", i, len(tuple), err)
		}
		if got, err := decodeU64(tuple[0]); err != nil || got != want.escrowID {
			t.Fatalf("op %d escrow id = %d, %v", i, got, err)
		}
		if got := decodeEnumName(t, tuple[1]); got != want.action {
			t.Fatalf("op %d action = %q, want %q", i, got, want.action)
		}
	}

	if _, err := settleManyArgs(caller, []SettleOp{{EscrowID: 1, Action: SettleAction(7)}}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("unknown action error = %v", err)
	}
}

// decodeEnumName returns the single symbol of a Soroban unit enum variant.
func decodeEnumName(t *testing.T, v xdr.ScVal) string {
	t.Helper()
	if v.Type != xdr.ScValTypeScvVec || v.Vec == nil || *v.Vec == nil {
		t.Fatalf("enum ScVal has type %s", v.Type)
	}
	variants := **v.Vec
	if len(variants) != 1 || variants[0].Type != xdr.ScValTypeScvSymbol || variants[0].Sym == nil {
		t.Fatal("enum ScVal is not a one-element symbol vec")
	}
	return string(*variants[0].Sym)
}

func TestCreateEscrowArgsValidation(t *testing.T) {
	payer := keypair.MustRandom().Address()
	payee := keypair.MustRandom().Address()
	releaser := keypair.MustRandom().Address()
	tooLong := string(make([]byte, maxConditionRefLength+1))
	maxPlusOne := new(big.Int).Add(maxI128, big.NewInt(1))

	tests := []struct {
		name      string
		payee     string
		token     string
		amount    *big.Int
		condition string
		releasers []string
		threshold uint32
	}{
		{name: "no payee", payee: "", token: testContractID, amount: big.NewInt(1), releasers: []string{releaser}, threshold: 1},
		{name: "no token", payee: payee, token: "", amount: big.NewInt(1), releasers: []string{releaser}, threshold: 1},
		{name: "nil amount", payee: payee, token: testContractID, amount: nil, releasers: []string{releaser}, threshold: 1},
		{name: "zero amount", payee: payee, token: testContractID, amount: big.NewInt(0), releasers: []string{releaser}, threshold: 1},
		{name: "negative amount", payee: payee, token: testContractID, amount: big.NewInt(-1), releasers: []string{releaser}, threshold: 1},
		{name: "over i128", payee: payee, token: testContractID, amount: maxPlusOne, releasers: []string{releaser}, threshold: 1},
		{name: "condition too long", payee: payee, token: testContractID, amount: big.NewInt(1), condition: tooLong, releasers: []string{releaser}, threshold: 1},
		{name: "no releasers", payee: payee, token: testContractID, amount: big.NewInt(1), releasers: nil, threshold: 1},
		{name: "too many releasers", payee: payee, token: testContractID, amount: big.NewInt(1), releasers: make([]string, maxReleasers+1), threshold: 1},
		{name: "zero threshold", payee: payee, token: testContractID, amount: big.NewInt(1), releasers: []string{releaser}, threshold: 0},
		{name: "threshold above count", payee: payee, token: testContractID, amount: big.NewInt(1), releasers: []string{releaser}, threshold: 2},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := createEscrowArgs(payer, test.payee, test.token, test.amount, test.condition, test.releasers, test.threshold, nil, nil, false, false)
			if !errors.Is(err, ErrInvalidArgument) {
				t.Fatalf("error = %v, want ErrInvalidArgument", err)
			}
		})
	}
}
