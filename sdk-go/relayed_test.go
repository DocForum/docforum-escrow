package escrow

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/stellar/go-stellar-sdk/keypair"
	"github.com/stellar/go-stellar-sdk/network"
	protocol "github.com/stellar/go-stellar-sdk/protocols/rpc"
	"github.com/stellar/go-stellar-sdk/txnbuild"
	"github.com/stellar/go-stellar-sdk/xdr"
)

// addressAuthEntry builds the address-credential auth entry a simulation
// reports for a release/refund caller.
func addressAuthEntry(t *testing.T, caller, contractID string) xdr.SorobanAuthorizationEntry {
	t.Helper()
	callerAddress, err := parseScAddress(caller)
	if err != nil {
		t.Fatal(err)
	}
	contractAddress, err := parseScAddress(contractID)
	if err != nil {
		t.Fatal(err)
	}
	return xdr.SorobanAuthorizationEntry{
		Credentials: xdr.SorobanCredentials{
			Type: xdr.SorobanCredentialsTypeSorobanCredentialsAddress,
			Address: &xdr.SorobanAddressCredentials{
				Address:                   callerAddress,
				Nonce:                     11,
				SignatureExpirationLedger: 0,
				Signature:                 scvVoid(),
			},
		},
		RootInvocation: xdr.SorobanAuthorizedInvocation{
			Function: xdr.SorobanAuthorizedFunction{
				Type: xdr.SorobanAuthorizedFunctionTypeSorobanAuthorizedFunctionTypeContractFn,
				ContractFn: &xdr.InvokeContractArgs{
					ContractAddress: contractAddress,
					FunctionName:    xdr.ScSymbol("release"),
					Args:            []xdr.ScVal{scvU64(7)},
				},
			},
			SubInvocations: []xdr.SorobanAuthorizedInvocation{},
		},
	}
}

func testTransactionData(t *testing.T) (xdr.SorobanTransactionData, string) {
	t.Helper()
	data := xdr.SorobanTransactionData{
		Resources:   xdr.SorobanResources{},
		ResourceFee: 1_000,
	}
	encoded, err := xdr.MarshalBase64(data)
	if err != nil {
		t.Fatal(err)
	}
	return data, encoded
}

// authorizeFixture simulates a release for releaser/relayer and returns the
// fake RPC and client wired for it.
func authorizeFixture(t *testing.T, releaser, relayer string) (*fakeRPC, *Client) {
	t.Helper()
	entry := addressAuthEntry(t, releaser, testContractID)
	entryXDR, err := xdr.MarshalBase64(entry)
	if err != nil {
		t.Fatal(err)
	}
	_, transactionDataXDR := testTransactionData(t)

	f := newFakeRPC()
	retval := returnValueXDR(t, scvVoid())
	f.simulateResponse = protocol.SimulateTransactionResponse{
		LatestLedger:       f.latestLedger,
		TransactionDataXDR: transactionDataXDR,
		Results:            []protocol.SimulateHostFunctionResult{{AuthXDR: &[]string{entryXDR}, ReturnValueXDR: &retval}},
	}
	client := newTestClient(t, f)
	client.signer = NewKeypairSignerFromKeypair(mustKeypair(t, releaser), network.TestNetworkPassphrase)
	return f, client
}

func mustKeypair(t *testing.T, address string) *keypair.Full {
	t.Helper()
	// Tests need the secret to sign; each fixture generates its own keypair and
	// records the matching address, so the caller always passes a real one.
	kp, ok := testKeypairs[address]
	if !ok {
		t.Fatalf("no test keypair for %q", address)
	}
	return kp
}

var testKeypairs = map[string]*keypair.Full{}

func newTestKeypair(t *testing.T) *keypair.Full {
	t.Helper()
	kp := keypair.MustRandom()
	testKeypairs[kp.Address()] = kp
	return kp
}

func TestAuthorizeReleaseProducesPortableAuthorization(t *testing.T) {
	releaser := newTestKeypair(t)
	relayer := keypair.MustRandom()
	f, client := authorizeFixture(t, releaser.Address(), relayer.Address())

	authorization, err := client.AuthorizeRelease(context.Background(), 7, relayer.Address())
	if err != nil {
		t.Fatal(err)
	}
	if authorization.ExpiresAtLedger != f.latestLedger+RelayedAuthorizationTTLLedgers {
		t.Fatalf("ExpiresAtLedger = %d, want %d", authorization.ExpiresAtLedger, f.latestLedger+RelayedAuthorizationTTLLedgers)
	}

	var payload assembledTransactionJSON
	if err := json.Unmarshal([]byte(authorization.Transaction), &payload); err != nil {
		t.Fatalf("authorization.Transaction is not JSON: %v", err)
	}
	if payload.Method != "release" {
		t.Fatalf("method = %q, want release", payload.Method)
	}
	if payload.SimulationTransactionData == "" {
		t.Fatal("simulationTransactionData is empty")
	}

	var envelope xdr.TransactionEnvelope
	if err := xdr.SafeUnmarshalBase64(payload.Tx, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.V1 == nil || len(envelope.V1.Tx.Operations) != 1 {
		t.Fatal("authorization envelope must have exactly one operation")
	}
	source := envelope.V1.Tx.SourceAccount
	if source.Ed25519 == nil {
		t.Fatal("authorization envelope has no account source")
	}
	var sourceID xdr.AccountId
	sourceID.Type = xdr.PublicKeyTypePublicKeyTypeEd25519
	sourceID.Ed25519 = source.Ed25519
	if sourceID.Address() != relayer.Address() {
		t.Fatalf("envelope source = %q, want relayer %q", sourceID.Address(), relayer.Address())
	}
	if len(envelope.V1.Signatures) != 0 {
		t.Fatal("authorization envelope must be unsigned; only the relayer signs it")
	}

	if len(payload.SimulationResult.Auth) != 1 {
		t.Fatalf("auth entries = %d, want 1", len(payload.SimulationResult.Auth))
	}
	var entry xdr.SorobanAuthorizationEntry
	if err := xdr.SafeUnmarshalBase64(payload.SimulationResult.Auth[0], &entry); err != nil {
		t.Fatal(err)
	}
	if entry.Credentials.Address == nil {
		t.Fatal("releaser auth entry lost its address credentials")
	}
	if entry.Credentials.Address.SignatureExpirationLedger != xdr.Uint32(authorization.ExpiresAtLedger) {
		t.Fatalf(
			"auth entry expiration = %d, want %d",
			entry.Credentials.Address.SignatureExpirationLedger, authorization.ExpiresAtLedger,
		)
	}
	if entry.Credentials.Address.Signature.Type == xdr.ScValTypeScvVoid {
		t.Fatal("releaser auth entry was not signed")
	}
}

func TestAuthorizeAndSubmitWithSeparateRelayer(t *testing.T) {
	releaser := newTestKeypair(t)
	relayer := newTestKeypair(t)
	f, client := authorizeFixture(t, releaser.Address(), relayer.Address())

	authorization, err := client.AuthorizeRelease(context.Background(), 7, relayer.Address())
	if err != nil {
		t.Fatal(err)
	}

	relayerSigner := NewKeypairSignerFromKeypair(relayer, network.TestNetworkPassphrase)
	result, err := client.SubmitRelayed(context.Background(), SettlementRelease, authorization, relayerSigner)
	if err != nil {
		t.Fatal(err)
	}
	if result.TxHash != "fakehash" {
		t.Fatalf("TxHash = %q", result.TxHash)
	}
	if len(f.sentRequests) != 1 {
		t.Fatalf("sent requests = %d, want 1", len(f.sentRequests))
	}

	var envelope xdr.TransactionEnvelope
	if err := xdr.SafeUnmarshalBase64(f.sentRequests[0].Transaction, &envelope); err != nil {
		t.Fatal(err)
	}
	if len(envelope.V1.Signatures) != 1 {
		t.Fatalf("envelope signatures = %d, want exactly the relayer's", len(envelope.V1.Signatures))
	}
	hash, err := network.HashTransactionInEnvelope(envelope, network.TestNetworkPassphrase)
	if err != nil {
		t.Fatal(err)
	}
	if err := relayer.Verify(hash[:], envelope.V1.Signatures[0].Signature); err != nil {
		t.Fatalf("envelope was not signed by the relayer: %v", err)
	}
	if envelope.V1.Tx.Ext.SorobanData == nil {
		t.Fatal("submitted envelope is missing its Soroban transaction data")
	}
	invoke := envelope.V1.Tx.Operations[0].Body.InvokeHostFunctionOp
	if invoke == nil || len(invoke.Auth) != 1 {
		t.Fatal("submitted envelope is missing the releaser's auth entry")
	}
}

// TestSubmitRelayedAcceptsTypeScriptFixture feeds SubmitRelayed the JSON shape
// the TypeScript SDK emits (AssembledTransaction.toJSON), so the two SDKs stay
// interoperable.
func TestSubmitRelayedAcceptsTypeScriptFixture(t *testing.T) {
	releaser := keypair.MustRandom()
	relayer := newTestKeypair(t)
	_, transactionDataXDR := testTransactionData(t)

	op := txnbuild.InvokeHostFunction{
		HostFunction: xdr.HostFunction{
			Type: xdr.HostFunctionTypeHostFunctionTypeInvokeContract,
			InvokeContract: &xdr.InvokeContractArgs{
				ContractAddress: mustScAddress(t, testContractID),
				FunctionName:    xdr.ScSymbol("refund"),
				Args:            []xdr.ScVal{scvU64(7), mustScValAddress(t, releaser.Address())},
			},
		},
	}
	tx, err := txnbuild.NewTransaction(txnbuild.TransactionParams{
		SourceAccount:        &txnbuild.SimpleAccount{AccountID: relayer.Address(), Sequence: 3},
		IncrementSequenceNum: true,
		Operations:           []txnbuild.Operation{&op},
		BaseFee:              txnbuild.MinBaseFee,
		Preconditions:        txnbuild.Preconditions{TimeBounds: txnbuild.NewTimeout(30)},
	})
	if err != nil {
		t.Fatal(err)
	}
	envelopeXDR, err := tx.Base64()
	if err != nil {
		t.Fatal(err)
	}
	entry := addressAuthEntry(t, releaser.Address(), testContractID)
	entryXDR, err := xdr.MarshalBase64(entry)
	if err != nil {
		t.Fatal(err)
	}

	// Exactly the fields @stellar/stellar-sdk's AssembledTransaction.toJSON
	// writes, in its shape.
	fixture := map[string]any{
		"method": "refund",
		"tx":     envelopeXDR,
		"simulationResult": map[string]any{
			"auth":   []string{entryXDR},
			"retval": returnValueXDR(t, scvVoid()),
		},
		"simulationTransactionData": transactionDataXDR,
	}
	encoded, err := json.Marshal(fixture)
	if err != nil {
		t.Fatal(err)
	}

	f := newFakeRPC()
	client := newTestClient(t, f)
	authorization := RelayedAuthorization{Transaction: string(encoded), ExpiresAtLedger: f.latestLedger + 5}
	if _, err := client.SubmitRelayed(context.Background(), SettlementRefund, authorization, NewKeypairSignerFromKeypair(relayer, network.TestNetworkPassphrase)); err != nil {
		t.Fatalf("SubmitRelayed(TypeScript fixture) = %v", err)
	}
	if len(f.sentRequests) != 1 {
		t.Fatalf("sent requests = %d, want 1", len(f.sentRequests))
	}
}

func TestSubmitRelayedRejectsExpiredAuthorization(t *testing.T) {
	f := newFakeRPC()
	f.latestLedger = 500
	client := newTestClient(t, f)
	authorization := RelayedAuthorization{
		Transaction:     `{"method":"release","tx":"","simulationResult":{"auth":[],"retval":""},"simulationTransactionData":""}`,
		ExpiresAtLedger: 400,
	}
	_, err := client.SubmitRelayed(
		context.Background(), SettlementRelease, authorization,
		NewKeypairSignerFromKeypair(newTestKeypair(t), network.TestNetworkPassphrase),
	)
	if !errors.Is(err, ErrAuthorizationExpired) {
		t.Fatalf("SubmitRelayed() = %v, want ErrAuthorizationExpired", err)
	}
	if len(f.sentRequests) != 0 {
		t.Fatal("an expired authorization was submitted")
	}
}

func TestSubmitRelayedRejectsMethodMismatch(t *testing.T) {
	client := newTestClient(t, newFakeRPC())
	authorization := RelayedAuthorization{
		Transaction:     `{"method":"release","tx":"","simulationResult":{"auth":[],"retval":""},"simulationTransactionData":""}`,
		ExpiresAtLedger: 1_000,
	}
	_, err := client.SubmitRelayed(
		context.Background(), SettlementRefund, authorization,
		NewKeypairSignerFromKeypair(newTestKeypair(t), network.TestNetworkPassphrase),
	)
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("SubmitRelayed() = %v, want ErrInvalidArgument", err)
	}
}

func TestSubmitRelayedRejectsMultipleOperations(t *testing.T) {
	releaser := keypair.MustRandom()
	relayer := newTestKeypair(t)
	_, transactionDataXDR := testTransactionData(t)

	invoke := txnbuild.InvokeHostFunction{
		HostFunction: xdr.HostFunction{
			Type: xdr.HostFunctionTypeHostFunctionTypeInvokeContract,
			InvokeContract: &xdr.InvokeContractArgs{
				ContractAddress: mustScAddress(t, testContractID),
				FunctionName:    xdr.ScSymbol("release"),
				Args:            []xdr.ScVal{scvU64(7), mustScValAddress(t, releaser.Address())},
			},
		},
	}
	payment := txnbuild.Payment{
		Destination: releaser.Address(),
		Amount:      "1.0000000",
		Asset:       txnbuild.NativeAsset{},
	}
	tx, err := txnbuild.NewTransaction(txnbuild.TransactionParams{
		SourceAccount:        &txnbuild.SimpleAccount{AccountID: relayer.Address(), Sequence: 4},
		IncrementSequenceNum: true,
		Operations:           []txnbuild.Operation{&invoke, &payment},
		BaseFee:              txnbuild.MinBaseFee,
		Preconditions:        txnbuild.Preconditions{TimeBounds: txnbuild.NewTimeout(30)},
	})
	if err != nil {
		t.Fatal(err)
	}
	envelopeXDR, err := tx.Base64()
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]any{
		"method": "release",
		"tx":     envelopeXDR,
		"simulationResult": map[string]any{
			"auth":   []string{},
			"retval": returnValueXDR(t, scvVoid()),
		},
		"simulationTransactionData": transactionDataXDR,
	})
	if err != nil {
		t.Fatal(err)
	}
	client := newTestClient(t, newFakeRPC())
	_, err = client.SubmitRelayed(
		context.Background(),
		SettlementRelease,
		RelayedAuthorization{Transaction: string(payload), ExpiresAtLedger: 1_000},
		NewKeypairSignerFromKeypair(relayer, network.TestNetworkPassphrase),
	)
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("SubmitRelayed() = %v, want ErrInvalidArgument for two operations", err)
	}
}

func TestSubmitRelayedRejectsEnvelopeForADifferentMethod(t *testing.T) {
	releaser := keypair.MustRandom()
	relayer := newTestKeypair(t)
	_, transactionDataXDR := testTransactionData(t)

	invoke := txnbuild.InvokeHostFunction{
		HostFunction: xdr.HostFunction{
			Type: xdr.HostFunctionTypeHostFunctionTypeInvokeContract,
			InvokeContract: &xdr.InvokeContractArgs{
				ContractAddress: mustScAddress(t, testContractID),
				FunctionName:    xdr.ScSymbol("refund"),
				Args:            []xdr.ScVal{scvU64(7), mustScValAddress(t, releaser.Address())},
			},
		},
	}
	tx, err := txnbuild.NewTransaction(txnbuild.TransactionParams{
		SourceAccount:        &txnbuild.SimpleAccount{AccountID: relayer.Address(), Sequence: 5},
		IncrementSequenceNum: true,
		Operations:           []txnbuild.Operation{&invoke},
		BaseFee:              txnbuild.MinBaseFee,
		Preconditions:        txnbuild.Preconditions{TimeBounds: txnbuild.NewTimeout(30)},
	})
	if err != nil {
		t.Fatal(err)
	}
	envelopeXDR, err := tx.Base64()
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]any{
		"method": "refund",
		"tx":     envelopeXDR,
		"simulationResult": map[string]any{
			"auth":   []string{},
			"retval": returnValueXDR(t, scvVoid()),
		},
		"simulationTransactionData": transactionDataXDR,
	})
	if err != nil {
		t.Fatal(err)
	}
	client := newTestClient(t, newFakeRPC())
	// The authorization declares `release`, but the envelope invokes `refund`.
	_, err = client.SubmitRelayed(
		context.Background(),
		SettlementRelease,
		RelayedAuthorization{Transaction: string(payload), ExpiresAtLedger: 1_000},
		NewKeypairSignerFromKeypair(relayer, network.TestNetworkPassphrase),
	)
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("SubmitRelayed() = %v, want ErrInvalidArgument for a mismatched envelope", err)
	}
}

func TestSubmitRelayedRequiresRelayerAsSource(t *testing.T) {
	releaser := newTestKeypair(t)
	authorizedRelayer := keypair.MustRandom()
	otherSigner := newTestKeypair(t)
	f, client := authorizeFixture(t, releaser.Address(), authorizedRelayer.Address())
	authorization, err := client.AuthorizeRelease(context.Background(), 7, authorizedRelayer.Address())
	if err != nil {
		t.Fatal(err)
	}
	// A different account cannot submit: its signature would not authorize the
	// authorization's envelope as the relayer.
	_, err = client.SubmitRelayed(
		context.Background(), SettlementRelease, authorization,
		NewKeypairSignerFromKeypair(otherSigner, network.TestNetworkPassphrase),
	)
	if !errors.Is(err, ErrUnsupportedAuthorization) {
		t.Fatalf("SubmitRelayed() = %v, want ErrUnsupportedAuthorization", err)
	}
	if len(f.sentRequests) != 0 {
		t.Fatalf("sent requests = %d, want 0", len(f.sentRequests))
	}
}

func mustScAddress(t *testing.T, address string) xdr.ScAddress {
	t.Helper()
	parsed, err := parseScAddress(address)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustScValAddress(t *testing.T, address string) xdr.ScVal {
	t.Helper()
	value, err := scvAddress(address)
	if err != nil {
		t.Fatal(err)
	}
	return value
}
