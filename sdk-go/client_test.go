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

	args, err := createEscrowArgs(payer, payee, testContractID, amount, "ref-1", []string{releaser}, 1, &deadline, nil, nil, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 10 {
		t.Fatalf("arg count = %d, want 10", len(args))
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
	if decoded, err := decodeOptionString(args[7]); err != nil || decoded != nil {
		t.Fatalf("refund to = %v, %v", decoded, err)
	}
	if decoded, err := decodeOptionU64(args[8]); err != nil || decoded != nil {
		t.Fatalf("release not before = %v, %v", decoded, err)
	}
	if decoded, err := decodeBool(args[9]); err != nil || !decoded {
		t.Fatalf("notify payee = %v, %v", decoded, err)
	}
}

func TestCreateEscrowArgsQuorum(t *testing.T) {
	payer := keypair.MustRandom().Address()
	payee := keypair.MustRandom().Address()
	releasers := []string{keypair.MustRandom().Address(), keypair.MustRandom().Address()}
	args, err := createEscrowArgs(payer, payee, testContractID, big.NewInt(1), "", releasers, 2, nil, nil, nil, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 11 {
		t.Fatalf("arg count = %d, want 11", len(args))
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
	if decoded, err := decodeOptionString(args[8]); err != nil || decoded != nil {
		t.Fatalf("refund to = %v, %v", decoded, err)
	}
	if decoded, err := decodeOptionU64(args[9]); err != nil || decoded != nil {
		t.Fatalf("release not before = %v, %v", decoded, err)
	}
}

func TestCreateEscrowArgShape(t *testing.T) {
	payer := keypair.MustRandom().Address()
	payee := keypair.MustRandom().Address()
	releaser := keypair.MustRandom().Address()

	single, err := createEscrowArgs(payer, payee, testContractID, big.NewInt(1), "", []string{releaser}, 1, nil, nil, nil, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(single) != 10 {
		t.Fatalf("create_escrow args = %d, want 10", len(single))
	}
	if single[5].Type != xdr.ScValTypeScvAddress {
		t.Fatalf("create_escrow releaser arg type = %s, want address", single[5].Type)
	}

	multi, err := createEscrowArgs(payer, payee, testContractID, big.NewInt(1), "", []string{releaser}, 1, nil, nil, nil, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(multi) != 11 {
		t.Fatalf("create_escrow_with_releasers args = %d, want 11", len(multi))
	}
	if multi[5].Type != xdr.ScValTypeScvVec || multi[6].Type != xdr.ScValTypeScvU32 {
		t.Fatalf("with-releasers args have types %s/%s, want vec/u32", multi[5].Type, multi[6].Type)
	}
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
			_, err := createEscrowArgs(payer, test.payee, test.token, test.amount, test.condition, test.releasers, test.threshold, nil, nil, nil, false, false)
			if !errors.Is(err, ErrInvalidArgument) {
				t.Fatalf("error = %v, want ErrInvalidArgument", err)
			}
		})
	}
}
