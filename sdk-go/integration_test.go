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

func TestIntegrationTopUpAndApprovals(t *testing.T) {
	client := integrationClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	signer, err := escrow.NewKeypairSigner(os.Getenv("STELLAR_SECRET_KEY"), os.Getenv("STELLAR_NETWORK_PASSPHRASE"))
	if err != nil {
		t.Fatal(err)
	}
	payee := keypair.MustRandom().Address()

	created, err := client.CreateEscrowWithReleasers(ctx, escrow.CreateEscrowWithReleasersParams{
		Payer:        signer.Address(),
		Payee:        payee,
		Token:        os.Getenv("ESCROW_TOKEN_ID"),
		Amount:       big.NewInt(10_000_000),
		ConditionRef: fmt.Sprintf("go-sdk-approvals-%d", time.Now().UnixNano()),
		Releasers:    []string{signer.Address()},
		Threshold:    1,
	})
	if err != nil {
		t.Fatalf("create escrow with releasers: %v", err)
	}

	if _, err := client.TopUp(ctx, created.EscrowID, big.NewInt(5_000_000)); err != nil {
		t.Fatalf("top up: %v", err)
	}
	stored, err := client.GetEscrow(ctx, created.EscrowID)
	if err != nil {
		t.Fatalf("get escrow after top up: %v", err)
	}
	if want := big.NewInt(15_000_000); stored.Amount.Cmp(want) != 0 {
		t.Fatalf("amount after top up = %s, want %s", stored.Amount, want)
	}

	if _, err := client.ReleaseWithApprovals(ctx, created.EscrowID, []escrow.Signer{signer}); err != nil {
		t.Fatalf("release with approvals: %v", err)
	}
	if status, err := client.GetStatus(ctx, created.EscrowID); err != nil {
		t.Fatalf("get status after release with approvals: %v", err)
	} else if status != escrow.EscrowStatusReleased {
		t.Fatalf("status after release with approvals = %s, want Released", status)
	}

	refundable, err := client.CreateEscrowWithReleasers(ctx, escrow.CreateEscrowWithReleasersParams{
		Payer:        signer.Address(),
		Payee:        keypair.MustRandom().Address(),
		Token:        os.Getenv("ESCROW_TOKEN_ID"),
		Amount:       big.NewInt(10_000_000),
		ConditionRef: fmt.Sprintf("go-sdk-refund-approvals-%d", time.Now().UnixNano()),
		Releasers:    []string{signer.Address()},
		Threshold:    1,
	})
	if err != nil {
		t.Fatalf("create refundable escrow: %v", err)
	}
	if _, err := client.RefundWithApprovals(ctx, refundable.EscrowID, []escrow.Signer{signer}); err != nil {
		t.Fatalf("refund with approvals: %v", err)
	}
	if status, err := client.GetStatus(ctx, refundable.EscrowID); err != nil {
		t.Fatalf("get status after refund with approvals: %v", err)
	} else if status != escrow.EscrowStatusRefunded {
		t.Fatalf("status after refund with approvals = %s, want Refunded", status)
	}
}

// contributorSigner returns the second funded identity the two-party cases
// need: the payee in the acceptance flow and one of the contributors in the
// pooled flow. Those tests skip rather than falling back to the deployer, so a
// green run always exercised a signer that is not Config.Signer.
func contributorSigner(t *testing.T) *escrow.KeypairSigner {
	t.Helper()
	secret := os.Getenv("STELLAR_CONTRIBUTOR_SECRET_KEY")
	if secret == "" {
		t.Skip("set STELLAR_CONTRIBUTOR_SECRET_KEY to run the two-party integration tests")
	}
	signer, err := escrow.NewKeypairSigner(secret, os.Getenv("STELLAR_NETWORK_PASSPHRASE"))
	if err != nil {
		t.Fatalf("create contributor signer: %v", err)
	}
	return signer
}

func TestIntegrationAcceptThenRelease(t *testing.T) {
	client := integrationClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	payer, err := escrow.NewKeypairSigner(os.Getenv("STELLAR_SECRET_KEY"), os.Getenv("STELLAR_NETWORK_PASSPHRASE"))
	if err != nil {
		t.Fatal(err)
	}
	payee := contributorSigner(t)

	created, err := client.CreateEscrowWithAcceptance(ctx, escrow.CreateEscrowWithAcceptanceParams{
		Payer:              payer.Address(),
		Payee:              payee.Address(),
		Token:              os.Getenv("ESCROW_TOKEN_ID"),
		Amount:             big.NewInt(10_000_000),
		ConditionRef:       fmt.Sprintf("go-sdk-accept-%d", time.Now().UnixNano()),
		Releaser:           payer.Address(),
		RequiresAcceptance: true,
	})
	if err != nil {
		t.Fatalf("create acceptance escrow: %v", err)
	}

	stored, err := client.GetEscrow(ctx, created.EscrowID)
	if err != nil {
		t.Fatalf("get escrow: %v", err)
	}
	if !stored.RequiresAcceptance || stored.AcceptedAt != nil {
		t.Fatalf("new escrow requires_acceptance/accepted_at = %v/%v", stored.RequiresAcceptance, stored.AcceptedAt)
	}

	// Release before the payee accepts is gated by the contract.
	if _, err := client.Release(ctx, created.EscrowID); !errors.Is(err, escrow.ErrAcceptanceRequired) {
		t.Fatalf("release before acceptance = %v, want ErrAcceptanceRequired", err)
	}

	// The payee is a different party than Config.Signer: it authorizes with
	// its own signer while the deployer account pays the fee.
	if _, err := client.Accept(ctx, created.EscrowID, payee); err != nil {
		t.Fatalf("accept: %v", err)
	}
	stored, err = client.GetEscrow(ctx, created.EscrowID)
	if err != nil {
		t.Fatalf("get escrow after accept: %v", err)
	}
	if stored.AcceptedAt == nil {
		t.Fatal("accepted_at is still unset after accept")
	}
	if _, err := client.Accept(ctx, created.EscrowID, payee); !errors.Is(err, escrow.ErrAlreadyAccepted) {
		t.Fatalf("second accept = %v, want ErrAlreadyAccepted", err)
	}

	if _, err := client.Release(ctx, created.EscrowID); err != nil {
		t.Fatalf("release after acceptance: %v", err)
	}
	if status, err := client.GetStatus(ctx, created.EscrowID); err != nil {
		t.Fatalf("get status: %v", err)
	} else if status != escrow.EscrowStatusReleased {
		t.Fatalf("status = %s, want Released", status)
	}
}

func TestIntegrationCancelBeforeAcceptance(t *testing.T) {
	client := integrationClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	payer, err := escrow.NewKeypairSigner(os.Getenv("STELLAR_SECRET_KEY"), os.Getenv("STELLAR_NETWORK_PASSPHRASE"))
	if err != nil {
		t.Fatal(err)
	}

	created, err := client.CreateEscrowWithAcceptance(ctx, escrow.CreateEscrowWithAcceptanceParams{
		Payer:              payer.Address(),
		Payee:              keypair.MustRandom().Address(),
		Token:              os.Getenv("ESCROW_TOKEN_ID"),
		Amount:             big.NewInt(5_000_000),
		ConditionRef:       fmt.Sprintf("go-sdk-cancel-%d", time.Now().UnixNano()),
		Releaser:           payer.Address(),
		RequiresAcceptance: true,
	})
	if err != nil {
		t.Fatalf("create acceptance escrow: %v", err)
	}

	if _, err := client.Cancel(ctx, created.EscrowID, payer); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if status, err := client.GetStatus(ctx, created.EscrowID); err != nil {
		t.Fatalf("get status: %v", err)
	} else if status != escrow.EscrowStatusCancelled {
		t.Fatalf("status = %s, want Cancelled", status)
	}
	// The cancelled escrow's record is reclaimed (ADR 0013); settlement lives
	// on in the Status entry.
	if _, err := client.GetEscrow(ctx, created.EscrowID); !errors.Is(err, escrow.ErrNotFound) {
		t.Fatalf("get escrow after cancel = %v, want ErrNotFound", err)
	}
	// Cancel is only for a not-yet-accepted acceptance escrow. A settled id
	// keeps its Status entry, so `load` answers NotFunded (ADR 0013) — the
	// same answer it gave before the record was reclaimed.
	if _, err := client.Cancel(ctx, created.EscrowID, payer); !errors.Is(err, escrow.ErrNotFunded) {
		t.Fatalf("second cancel = %v, want ErrNotFunded", err)
	}
}

func TestIntegrationPooledFailedRoundTwoClaims(t *testing.T) {
	client := integrationClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	creator, err := escrow.NewKeypairSigner(os.Getenv("STELLAR_SECRET_KEY"), os.Getenv("STELLAR_NETWORK_PASSPHRASE"))
	if err != nil {
		t.Fatal(err)
	}
	contributor := contributorSigner(t)

	// The deadline must be strictly in the future at creation, and claims
	// open only once it has passed: keep it short but leave the local
	// quickstart (and testnet) a few seconds of slack.
	deadline := uint64(time.Now().Unix()) + 15
	created, err := client.CreatePooledEscrow(ctx, escrow.CreatePooledEscrowParams{
		Creator:         creator.Address(),
		Payee:           keypair.MustRandom().Address(),
		Token:           os.Getenv("ESCROW_TOKEN_ID"),
		FundingTarget:   big.NewInt(100_000_000),
		ConditionRef:    fmt.Sprintf("go-sdk-pool-%d", time.Now().UnixNano()),
		Releaser:        creator.Address(),
		FundingDeadline: deadline,
	})
	if err != nil {
		t.Fatalf("create pooled escrow: %v", err)
	}

	pooled, err := client.GetPooled(ctx, created.EscrowID)
	if err != nil {
		t.Fatalf("get pooled: %v", err)
	}
	if pooled.FundingTarget.Cmp(big.NewInt(100_000_000)) != 0 || pooled.FundingDeadline != deadline {
		t.Fatalf("pooled config = %v/%d", pooled.FundingTarget, pooled.FundingDeadline)
	}
	// A non-pooled id is distinguishable from a missing one.
	if _, err := client.GetPooled(ctx, 9_999_999_999); !errors.Is(err, escrow.ErrNotPooled) {
		t.Fatalf("get_pooled on an unknown id = %v, want ErrNotPooled", err)
	}

	if _, err := client.Contribute(ctx, created.EscrowID, creator, big.NewInt(40_000_000)); err != nil {
		t.Fatalf("creator contributes: %v", err)
	}
	if _, err := client.Contribute(ctx, created.EscrowID, contributor, big.NewInt(50_000_000)); err != nil {
		t.Fatalf("contributor contributes: %v", err)
	}
	if _, err := client.Contribute(ctx, created.EscrowID, creator, big.NewInt(99_000_000)); !errors.Is(err, escrow.ErrFundingTargetReached) {
		t.Fatalf("overfunding = %v, want ErrFundingTargetReached", err)
	}

	// Claims are closed before the deadline.
	if _, err := client.ClaimRefund(ctx, created.EscrowID, creator); !errors.Is(err, escrow.ErrRefundNotOpen) {
		t.Fatalf("claim before the deadline = %v, want ErrRefundNotOpen", err)
	}
	// An address with no record is distinguishable from a zero contribution:
	// the Option is None, not an error.
	record, err := client.GetContribution(ctx, created.EscrowID, keypair.MustRandom().Address())
	if err != nil {
		t.Fatalf("get contribution for a non-contributor: %v", err)
	}
	if record != nil {
		t.Fatalf("non-contributor record = %#v, want nil", record)
	}

	for uint64(time.Now().Unix()) <= deadline+3 {
		time.Sleep(time.Second)
	}

	if _, err := client.ClaimRefund(ctx, created.EscrowID, contributor); err != nil {
		t.Fatalf("contributor claim: %v", err)
	}
	if _, err := client.ClaimRefund(ctx, created.EscrowID, creator); err != nil {
		t.Fatalf("creator claim: %v", err)
	}
	if status, err := client.GetStatus(ctx, created.EscrowID); err != nil {
		t.Fatalf("get status: %v", err)
	} else if status != escrow.EscrowStatusRefunded {
		t.Fatalf("status after the final claim = %s, want Refunded", status)
	}
	for _, who := range []string{creator.Address(), contributor.Address()} {
		record, err := client.GetContribution(ctx, created.EscrowID, who)
		if err != nil {
			t.Fatalf("get contribution for %s: %v", who, err)
		}
		if record == nil || !record.Refunded {
			t.Fatalf("contribution for %s = %#v, want refunded", who, record)
		}
	}
	if _, err := client.ClaimRefund(ctx, created.EscrowID, contributor); !errors.Is(err, escrow.ErrAlreadyRefunded) {
		t.Fatalf("second claim = %v, want ErrAlreadyRefunded", err)
	}
}

func TestIntegrationBatchCreateAndSettle(t *testing.T) {
	client := integrationClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	payer, err := escrow.NewKeypairSigner(os.Getenv("STELLAR_SECRET_KEY"), os.Getenv("STELLAR_NETWORK_PASSPHRASE"))
	if err != nil {
		t.Fatal(err)
	}
	payees := []string{keypair.MustRandom().Address(), keypair.MustRandom().Address()}
	refundAfter := uint64(time.Now().Unix()) + 3_600

	created, err := client.CreateEscrows(ctx, escrow.CreateEscrowsParams{
		Payer: payer.Address(),
		Items: []escrow.CreateItem{
			{Payee: payees[0], Token: os.Getenv("ESCROW_TOKEN_ID"), Amount: big.NewInt(1_000_000), ConditionRef: fmt.Sprintf("go-sdk-batch-a-%d", time.Now().UnixNano()), Releaser: payer.Address()},
			{Payee: payees[1], Token: os.Getenv("ESCROW_TOKEN_ID"), Amount: big.NewInt(2_000_000), ConditionRef: fmt.Sprintf("go-sdk-batch-b-%d", time.Now().UnixNano()), Releaser: payer.Address(), RefundAfter: &refundAfter},
		},
	})
	if err != nil {
		t.Fatalf("create escrows: %v", err)
	}
	if len(created.EscrowIDs) != 2 || len(created.TxHashes) != 1 {
		t.Fatalf("create result = %d ids / %d tx hashes, want 2/1", len(created.EscrowIDs), len(created.TxHashes))
	}

	settled, err := client.SettleMany(ctx, []escrow.SettleOp{
		{EscrowID: created.EscrowIDs[0], Action: escrow.SettleRelease},
		{EscrowID: created.EscrowIDs[1], Action: escrow.SettleRelease},
		{EscrowID: created.EscrowIDs[1], Action: escrow.SettleRefund}, // already settled
	})
	if err != nil {
		t.Fatalf("settle many: %v", err)
	}
	if len(settled.Results) != 3 {
		t.Fatalf("settle results = %d, want 3", len(settled.Results))
	}
	if !settled.Results[0].OK() || !settled.Results[1].OK() {
		t.Fatalf("first two ops failed: %v / %v", settled.Results[0].Err, settled.Results[1].Err)
	}
	if !errors.Is(settled.Results[2].Err, escrow.ErrNotFunded) {
		t.Fatalf("third op = %v, want ErrNotFunded", settled.Results[2].Err)
	}
	for _, id := range created.EscrowIDs {
		if status, err := client.GetStatus(ctx, id); err != nil {
			t.Fatalf("get status for %d: %v", id, err)
		} else if status != escrow.EscrowStatusReleased {
			t.Fatalf("status for %d = %s, want Released", id, status)
		}
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
