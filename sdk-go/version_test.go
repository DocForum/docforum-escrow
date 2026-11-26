package escrow

import (
	"context"
	"errors"
	"math/big"
	"testing"
	"time"

	"github.com/stellar/go-stellar-sdk/clients/rpcclient"
	"github.com/stellar/go-stellar-sdk/keypair"
	"github.com/stellar/go-stellar-sdk/network"
	protocol "github.com/stellar/go-stellar-sdk/protocols/rpc"
	"github.com/stellar/go-stellar-sdk/txnbuild"
	"github.com/stellar/go-stellar-sdk/xdr"
)

// fakeRPC is an offline stand-in for *rpcclient.Client. Every method the client
// uses is answered from struct fields, and the simulated/ submitted calls are
// recorded so tests can assert on what the client asked for.
type fakeRPC struct {
	latestLedger     uint32
	sequence         int64
	simulateResponse protocol.SimulateTransactionResponse
	simulateErr      error
	sentResponse     protocol.SendTransactionResponse
	finalResponse    protocol.GetTransactionResponse

	simulatedCalls []string
	sentRequests   []protocol.SendTransactionRequest
}

func newFakeRPC() *fakeRPC {
	return &fakeRPC{
		latestLedger: 100,
		sequence:     7,
		sentResponse: protocol.SendTransactionResponse{Hash: "fakehash"},
		finalResponse: protocol.GetTransactionResponse{
			TransactionDetails: protocol.TransactionDetails{Status: protocol.TransactionStatusSuccess, Ledger: 101},
		},
	}
}

func (f *fakeRPC) Close() error { return nil }

func (f *fakeRPC) GetNetwork(context.Context) (protocol.GetNetworkResponse, error) {
	return protocol.GetNetworkResponse{Passphrase: network.TestNetworkPassphrase}, nil
}

func (f *fakeRPC) GetLatestLedger(context.Context) (protocol.GetLatestLedgerResponse, error) {
	return protocol.GetLatestLedgerResponse{Sequence: f.latestLedger}, nil
}

func (f *fakeRPC) LoadAccount(_ context.Context, address string) (txnbuild.Account, error) {
	return &txnbuild.SimpleAccount{AccountID: address, Sequence: f.sequence}, nil
}

func (f *fakeRPC) SimulateTransaction(_ context.Context, request protocol.SimulateTransactionRequest) (protocol.SimulateTransactionResponse, error) {
	f.simulatedCalls = append(f.simulatedCalls, invokedMethodName(request.Transaction))
	return f.simulateResponse, f.simulateErr
}

func (f *fakeRPC) SendTransaction(_ context.Context, request protocol.SendTransactionRequest) (protocol.SendTransactionResponse, error) {
	f.sentRequests = append(f.sentRequests, request)
	return f.sentResponse, nil
}

func (f *fakeRPC) PollTransactionWithOptions(context.Context, string, rpcclient.PollTransactionOptions) (protocol.GetTransactionResponse, error) {
	return f.finalResponse, nil
}

func invokedMethodName(envelopeXDR string) string {
	var envelope xdr.TransactionEnvelope
	if err := xdr.SafeUnmarshalBase64(envelopeXDR, &envelope); err != nil || envelope.V1 == nil {
		return ""
	}
	for _, operation := range envelope.V1.Tx.Operations {
		if operation.Body.InvokeHostFunctionOp != nil && operation.Body.InvokeHostFunctionOp.HostFunction.InvokeContract != nil {
			return string(operation.Body.InvokeHostFunctionOp.HostFunction.InvokeContract.FunctionName)
		}
	}
	return ""
}

// newTestClient wires a Client to f and shortens the poll interval so the fake
// poll never waits.
func newTestClient(t *testing.T, f *fakeRPC) *Client {
	t.Helper()
	client, err := New(Config{
		ContractID:   testContractID,
		PollInterval: time.Millisecond,
		PollTimeout:  time.Second,
		// Reads simulate from the signer's account, so even a read-only test
		// needs one configured.
		Signer: NewKeypairSignerFromKeypair(keypair.MustRandom(), network.TestNetworkPassphrase),
	})
	if err != nil {
		t.Fatal(err)
	}
	client.rpc = f
	return client
}

func returnValueXDR(t *testing.T, value xdr.ScVal) string {
	t.Helper()
	encoded, err := xdr.MarshalBase64(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func simulateReturning(t *testing.T, f *fakeRPC, value xdr.ScVal) {
	t.Helper()
	retval := returnValueXDR(t, value)
	f.simulateResponse = protocol.SimulateTransactionResponse{
		LatestLedger: f.latestLedger,
		Results:      []protocol.SimulateHostFunctionResult{{ReturnValueXDR: &retval}},
	}
}

func TestVersionReadsContractVersion(t *testing.T) {
	f := newFakeRPC()
	simulateReturning(t, f, scvString("3.1.0"))
	client := newTestClient(t, f)

	version, err := client.Version(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if version != "3.1.0" {
		t.Fatalf("Version() = %q, want 3.1.0", version)
	}
	if len(f.simulatedCalls) != 1 || f.simulatedCalls[0] != "version" {
		t.Fatalf("simulated calls = %v, want [version]", f.simulatedCalls)
	}
}

func TestVersionMissingFunctionIsTypedError(t *testing.T) {
	f := newFakeRPC()
	f.simulateResponse = protocol.SimulateTransactionResponse{Error: "HostError: Error(WasmVm, MissingValue)"}
	client := newTestClient(t, f)

	_, err := client.Version(context.Background())
	if err == nil {
		t.Fatal("Version() = nil error, want a typed error")
	}
	var unavailable *VersionUnavailableError
	if !errors.As(err, &unavailable) {
		t.Fatalf("Version() error = %v, want *VersionUnavailableError", err)
	}
	if unavailable.ContractID != testContractID {
		t.Fatalf("ContractID = %q", unavailable.ContractID)
	}
	if !errors.Is(err, ErrVersionUnavailable) {
		t.Fatalf("errors.Is(err, ErrVersionUnavailable) = false for %v", err)
	}

	if err := client.VerifyContractVersion(context.Background()); !errors.Is(err, ErrVersionUnavailable) {
		t.Fatalf("VerifyContractVersion() = %v, want ErrVersionUnavailable", err)
	}
}

func TestIsPausedAndPauseAdmin(t *testing.T) {
	admin := keypair.MustRandom().Address()

	f := newFakeRPC()
	simulateReturning(t, f, scvBool(true))
	client := newTestClient(t, f)

	paused, err := client.IsPaused(context.Background())
	if err != nil || !paused {
		t.Fatalf("IsPaused() = %v, %v", paused, err)
	}
	if f.simulatedCalls[0] != "is_paused" {
		t.Fatalf("simulated %q, want is_paused", f.simulatedCalls[0])
	}

	adminValue, err := scvAddress(admin)
	if err != nil {
		t.Fatal(err)
	}
	simulateReturning(t, f, adminValue)
	got, err := client.GetPauseAdmin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || *got != admin {
		t.Fatalf("GetPauseAdmin() = %v, want %q", got, admin)
	}

	simulateReturning(t, f, scvVoid())
	none, err := client.GetPauseAdmin(context.Background())
	if err != nil || none != nil {
		t.Fatalf("GetPauseAdmin() with no admin = %v, %v", none, err)
	}
}

func TestSolvencyReadsBalanceAndLiabilities(t *testing.T) {
	f := newFakeRPC()
	balance, err := scvI128(big.NewInt(1_000))
	if err != nil {
		t.Fatal(err)
	}
	liabilities, err := scvI128(big.NewInt(400))
	if err != nil {
		t.Fatal(err)
	}
	simulateReturning(t, f, scvVec([]xdr.ScVal{balance, liabilities}))
	client := newTestClient(t, f)

	report, err := client.Solvency(context.Background(), testContractID)
	if err != nil {
		t.Fatal(err)
	}
	if report.Balance.Cmp(big.NewInt(1_000)) != 0 || report.Liabilities.Cmp(big.NewInt(400)) != 0 {
		t.Fatalf("report = %+v", report)
	}
	if !report.Solvent {
		t.Fatal("Solvent = false, want true")
	}
	if f.simulatedCalls[0] != "solvency" {
		t.Fatalf("simulated %q, want solvency", f.simulatedCalls[0])
	}
}

func TestContractVersionCheckRejectsUnsupportedVersionBeforeWrite(t *testing.T) {
	signer := NewKeypairSignerFromKeypair(keypair.MustRandom(), network.TestNetworkPassphrase)
	f := newFakeRPC()
	simulateReturning(t, f, scvString("4.0.0"))
	client := newTestClient(t, f)
	client.signer = signer
	client.contractVersionCheck = ContractVersionCheckRequired

	_, err := client.Release(context.Background(), 1)
	if !errors.Is(err, ErrUnsupportedContractVersion) {
		t.Fatalf("Release() = %v, want ErrUnsupportedContractVersion", err)
	}
	var unsupported *UnsupportedContractVersionError
	if !errors.As(err, &unsupported) || unsupported.Version != "4.0.0" {
		t.Fatalf("error = %v", err)
	}
	if len(f.sentRequests) != 0 {
		t.Fatal("a transaction was submitted despite the version rejection")
	}
}

func TestContractVersionCheckAutoSkipsLegacyDeploymentAndCaches(t *testing.T) {
	signer := NewKeypairSignerFromKeypair(keypair.MustRandom(), network.TestNetworkPassphrase)
	f := newFakeRPC()
	missing := "HostError: Error(WasmVm, MissingValue)"
	f.simulateErr = nil
	f.simulateResponse = protocol.SimulateTransactionResponse{Error: missing}
	client := newTestClient(t, f)
	client.signer = signer
	client.contractVersionCheck = ContractVersionCheckAuto

	// The deployment has no version(): Auto mode lets the write through.
	if err := client.ensureContractVersionChecked(context.Background()); err != nil {
		t.Fatalf("auto version check = %v, want nil for a legacy deployment", err)
	}
	if len(f.simulatedCalls) != 1 {
		t.Fatalf("version lookups = %d, want 1", len(f.simulatedCalls))
	}

	// A failed lookup is not cached: the next write retries.
	f.simulateErr = errors.New("rpc unavailable")
	f.simulateResponse = protocol.SimulateTransactionResponse{}
	client.contractVersionChecked = false
	f.simulatedCalls = nil
	if err := client.ensureContractVersionChecked(context.Background()); err != nil {
		t.Fatalf("auto version check with a failing RPC = %v, want nil", err)
	}
	if err := client.ensureContractVersionChecked(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(f.simulatedCalls) != 2 {
		t.Fatalf("version lookups = %d, want 2 (failed lookups are not cached)", len(f.simulatedCalls))
	}
	f.simulateErr = nil

	// A successful lookup within range is cached: a second write makes no call.
	simulateReturning(t, f, scvString("3.0.0"))
	client.contractVersionChecked = false
	f.simulatedCalls = nil
	if err := client.ensureContractVersionChecked(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := client.ensureContractVersionChecked(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(f.simulatedCalls) != 1 {
		t.Fatalf("version lookups = %d, want 1 (cached)", len(f.simulatedCalls))
	}
}

func TestIsSupportedContractVersionMatchesTypeScriptRange(t *testing.T) {
	supported := []string{"2.0.0", "2.5.3", "3.0.0", "3.1.2-rc.1"}
	for _, version := range supported {
		if !isSupportedContractVersion(version) {
			t.Fatalf("isSupportedContractVersion(%q) = false", version)
		}
	}
	unsupported := []string{"1.9.9", "4.0.0", "10.0.0", "not-a-version", ""}
	for _, version := range unsupported {
		if isSupportedContractVersion(version) {
			t.Fatalf("isSupportedContractVersion(%q) = true", version)
		}
	}
}

func (f *fakeRPC) GetEvents(_ context.Context, _ protocol.GetEventsRequest) (protocol.GetEventsResponse, error) {
	return protocol.GetEventsResponse{}, nil
}
