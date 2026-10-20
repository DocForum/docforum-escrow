//go:build integration

package escrow_test

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"os"
	"testing"
	"time"

	escrow "github.com/DocForum/docforum-escrow/sdk-go"
	"github.com/stellar/go-stellar-sdk/keypair"
)

func integrationClient(t *testing.T) *escrow.Client {
	t.Helper()
	if os.Getenv("ESCROW_INTEGRATION") != "1" {
		t.Skip("set ESCROW_INTEGRATION=1 and the STELLAR_*/ESCROW_* variables to run integration tests")
	}

	required := []string{
		"ESCROW_CONTRACT_ID",
		"ESCROW_TOKEN_ID",
		"STELLAR_RPC_URL",
		"STELLAR_NETWORK_PASSPHRASE",
		"STELLAR_SECRET_KEY",
	}
	for _, name := range required {
		if os.Getenv(name) == "" {
			t.Fatalf("%s is required when ESCROW_INTEGRATION=1", name)
		}
	}

	signer, err := escrow.NewKeypairSigner(os.Getenv("STELLAR_SECRET_KEY"), os.Getenv("STELLAR_NETWORK_PASSPHRASE"))
	if err != nil {
		t.Fatalf("create signer: %v", err)
	}
	client, err := escrow.New(escrow.Config{
		RPCURL:            os.Getenv("STELLAR_RPC_URL"),
		ContractID:        os.Getenv("ESCROW_CONTRACT_ID"),
		NetworkPassphrase: os.Getenv("STELLAR_NETWORK_PASSPHRASE"),
		Signer:            signer,
		PollTimeout:       2 * time.Minute,
	})
	if err != nil {
		t.Fatalf("create client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := client.CheckNetwork(ctx); err != nil {
		t.Fatalf("check network: %v", err)
	}
	return client
}

func TestIntegrationReleaseLifecycle(t *testing.T) {
	client := integrationClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	signer, err := escrow.NewKeypairSigner(os.Getenv("STELLAR_SECRET_KEY"), os.Getenv("STELLAR_NETWORK_PASSPHRASE"))
	if err != nil {
		t.Fatal(err)
	}
	payee := keypair.MustRandom().Address()
	amount := big.NewInt(10_000_000) // 1 XLM in stroops, held as an i128 on-chain.

	created, err := client.CreateEscrow(ctx, escrow.CreateEscrowParams{
		Payer:        signer.Address(),
		Payee:        payee,
		Token:        os.Getenv("ESCROW_TOKEN_ID"),
		Amount:       amount,
		ConditionRef: fmt.Sprintf("go-sdk-release-%d", time.Now().UnixNano()),
		Releaser:     signer.Address(),
	})
	if err != nil {
		t.Fatalf("create escrow: %v", err)
	}
	// The contract's NextId counter starts at 0, so a fresh deployment really
	// does hand out escrow id 0; only the transaction hash must be non-empty.
	if created.TxHash == "" {
		t.Fatal("create escrow returned an empty transaction hash")
	}

	status, err := client.GetStatus(ctx, created.EscrowID)
	if err != nil {
		t.Fatalf("get status: %v", err)
	}
	if status != escrow.EscrowStatusFunded {
		t.Fatalf("status after create = %s, want Funded", status)
	}

	stored, err := client.GetEscrow(ctx, created.EscrowID)
	if err != nil {
		t.Fatalf("get escrow: %v", err)
	}
	if stored.Payer != signer.Address() || stored.Payee != payee {
		t.Fatalf("stored parties = %s/%s, want %s/%s", stored.Payer, stored.Payee, signer.Address(), payee)
	}
	if stored.Token != os.Getenv("ESCROW_TOKEN_ID") {
		t.Fatalf("stored token = %s", stored.Token)
	}
	if stored.Amount.Cmp(amount) != 0 {
		t.Fatalf("stored amount = %s, want %s", stored.Amount, amount)
	}
	if len(stored.Releasers) != 1 || stored.Releasers[0] != signer.Address() || stored.Threshold != 1 {
		t.Fatalf("stored releasers/threshold = %v/%d", stored.Releasers, stored.Threshold)
	}
	if stored.Status != escrow.EscrowStatusFunded {
		t.Fatalf("stored status = %s, want Funded", stored.Status)
	}

	released, err := client.Release(ctx, created.EscrowID)
	if err != nil {
		t.Fatalf("release: %v", err)
	}
	if released.TxHash == "" {
		t.Fatal("release returned an empty transaction hash")
	}

	status, err = client.GetStatus(ctx, created.EscrowID)
	if err != nil {
		t.Fatalf("get status after release: %v", err)
	}
	if status != escrow.EscrowStatusReleased {
		t.Fatalf("status after release = %s, want Released", status)
	}
}

func TestIntegrationRefundLifecycle(t *testing.T) {
	client := integrationClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	signer, err := escrow.NewKeypairSigner(os.Getenv("STELLAR_SECRET_KEY"), os.Getenv("STELLAR_NETWORK_PASSPHRASE"))
	if err != nil {
		t.Fatal(err)
	}
	payee := keypair.MustRandom().Address()

	created, err := client.CreateEscrow(ctx, escrow.CreateEscrowParams{
		Payer:        signer.Address(),
		Payee:        payee,
		Token:        os.Getenv("ESCROW_TOKEN_ID"),
		Amount:       big.NewInt(5_000_000),
		ConditionRef: fmt.Sprintf("go-sdk-refund-%d", time.Now().UnixNano()),
		Releaser:     signer.Address(),
	})
	if err != nil {
		t.Fatalf("create escrow: %v", err)
	}

	refunded, err := client.Refund(ctx, created.EscrowID)
	if err != nil {
		t.Fatalf("refund: %v", err)
	}
	if refunded.TxHash == "" {
		t.Fatal("refund returned an empty transaction hash")
	}

	status, err := client.GetStatus(ctx, created.EscrowID)
	if err != nil {
		t.Fatalf("get status after refund: %v", err)
	}
	if status != escrow.EscrowStatusRefunded {
		t.Fatalf("status after refund = %s, want Refunded", status)
	}
}

func TestIntegrationUnknownEscrowIsNotFound(t *testing.T) {
	client := integrationClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	_, err := client.GetStatus(ctx, 9_999_999_999)
	if err == nil {
		t.Fatal("GetStatus on an unknown id succeeded")
	}
	if !errors.Is(err, escrow.ErrNotFound) {
		t.Fatalf("unknown escrow error = %v, want ErrNotFound", err)
	}
	var contractErr *escrow.ContractError
	if !errors.As(err, &contractErr) || contractErr.Code != 1 {
		t.Fatalf("errors.As did not expose contract code 1: %v", err)
	}
}
