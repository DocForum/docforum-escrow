package escrow

import (
	"context"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/stellar/go-stellar-sdk/clients/rpcclient"
	"github.com/stellar/go-stellar-sdk/network"
	protocol "github.com/stellar/go-stellar-sdk/protocols/rpc"
	"github.com/stellar/go-stellar-sdk/strkey"
	"github.com/stellar/go-stellar-sdk/txnbuild"
	"github.com/stellar/go-stellar-sdk/xdr"
)

const (
	defaultRPCURL            = "https://soroban-testnet.stellar.org"
	defaultHTTPTimeout       = 30 * time.Second
	defaultPollTimeout       = 60 * time.Second
	defaultTransactionWindow = 120 * time.Second
	maxConditionRefLength    = 64
	maxReleasers             = 10

	// MaxBatchSize is the largest number of escrows one `create_escrows`
	// transaction may create. It mirrors MAX_BATCH_SIZE in
	// contracts/escrow/src/constants.rs (see docs/adr/0012): 16 items, a
	// measured limit set by the Mainnet per-transaction events budget.
	// CreateEscrows chunks larger inputs automatically.
	MaxBatchSize = 16
	// MaxSettleOps is the largest number of operations one `settle_many`
	// transaction may carry. It mirrors MAX_SETTLE_OPS in
	// contracts/escrow/src/constants.rs (see docs/adr/0012): 12 ops, a
	// measured limit set by the same events budget. SettleMany chunks larger
	// inputs automatically.
	MaxSettleOps = 12
)

// Config configures a Client.
type Config struct {
	// RPCURL is the Soroban RPC endpoint. Defaults to the SDF testnet RPC.
	RPCURL string
	// ContractID is the deployed escrow contract (C...).
	ContractID string
	// NetworkPassphrase must match the network the RPC server serves. Defaults
	// to the Stellar testnet passphrase. The public/mainnet passphrase is
	// rejected: this SDK is testnet/local-only until the security review in
	// ROADMAP.md Phase E4 is complete.
	NetworkPassphrase string
	// HTTPClient optionally overrides the HTTP client used for RPC calls.
	HTTPClient *http.Client
	// PollTimeout bounds how long Release/Refund/etc. wait for a submitted
	// transaction to reach a terminal state. Defaults to 60s.
	PollTimeout time.Duration
	// PollInterval is the initial poll interval for transaction status.
	// Defaults to 500ms.
	PollInterval time.Duration
	// Signer authorizes transactions. It is optional at construction so
	// read-only clients can be built and validated, but every RPC method
	// currently needs an account to simulate from and returns
	// ErrSignerRequired when nil.
	Signer Signer
}

// Client is a Go client for the docforum-escrow Soroban contract.
type Client struct {
	rpc               *rpcclient.Client
	contractID        string
	contractAddress   xdr.ScAddress
	networkPassphrase string
	signer            Signer
	pollTimeout       time.Duration
	pollInterval      time.Duration
	txTimeout         time.Duration
}

// New validates cfg and creates a client. It does not make network requests;
// use CheckNetwork if you want to verify the RPC server's passphrase up front.
func New(cfg Config) (*Client, error) {
	if cfg.ContractID == "" {
		return nil, fmt.Errorf("%w: ContractID is required", ErrInvalidContractID)
	}
	if !strkey.IsValidContractAddress(cfg.ContractID) {
		return nil, fmt.Errorf("%w: %q is not a contract address", ErrInvalidContractID, cfg.ContractID)
	}
	contractAddress, err := parseScAddress(cfg.ContractID)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidContractID, err)
	}

	rpcURL := strings.TrimSpace(cfg.RPCURL)
	if rpcURL == "" {
		rpcURL = defaultRPCURL
	}
	parsed, err := url.Parse(rpcURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("%w: invalid RPC URL %q", ErrInvalidArgument, rpcURL)
	}

	passphrase := cfg.NetworkPassphrase
	if passphrase == "" {
		passphrase = network.TestNetworkPassphrase
	}
	if passphrase == network.PublicNetworkPassphrase {
		return nil, fmt.Errorf("%w: mainnet is not supported; this SDK is testnet/local-only", ErrNetworkMismatch)
	}

	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultHTTPTimeout}
	}

	pollTimeout := cfg.PollTimeout
	if pollTimeout <= 0 {
		pollTimeout = defaultPollTimeout
	}
	pollInterval := cfg.PollInterval
	if pollInterval <= 0 {
		pollInterval = 500 * time.Millisecond
	}
	txTimeout := pollTimeout + 30*time.Second
	if txTimeout < defaultTransactionWindow {
		txTimeout = defaultTransactionWindow
	}

	return &Client{
		rpc:               rpcclient.NewClient(rpcURL, httpClient),
		contractID:        cfg.ContractID,
		contractAddress:   contractAddress,
		networkPassphrase: passphrase,
		signer:            cfg.Signer,
		pollTimeout:       pollTimeout,
		pollInterval:      pollInterval,
		txTimeout:         txTimeout,
	}, nil
}

// Close releases idle HTTP connections used by the RPC client.
func (c *Client) Close() error {
	return c.rpc.Close()
}

// ContractID returns the configured escrow contract address.
func (c *Client) ContractID() string {
	return c.contractID
}

// CheckNetwork asks the RPC server for its network passphrase and compares it
// with Config.NetworkPassphrase. Returns ErrNetworkMismatch on disagreement.
func (c *Client) CheckNetwork(ctx context.Context) error {
	info, err := c.rpc.GetNetwork(ctx)
	if err != nil {
		return fmt.Errorf("escrow: get network: %w", err)
	}
	if info.Passphrase != c.networkPassphrase {
		return fmt.Errorf("%w: RPC reports %q, client configured for %q", ErrNetworkMismatch, info.Passphrase, c.networkPassphrase)
	}
	return nil
}

func (c *Client) requireSigner() (Signer, error) {
	if c.signer == nil {
		return nil, ErrSignerRequired
	}
	return c.signer, nil
}

// actorSigner resolves the party that authorizes a per-call signer argument.
// A nil argument means the configured signer.
func (c *Client) actorSigner(actor Signer) (Signer, error) {
	if actor != nil {
		return actor, nil
	}
	return c.requireSigner()
}

// authorizedSigners returns the signer list for a call that actor (possibly
// nil, meaning the configured signer) authorizes. When the acting party is the
// configured signer it is also the transaction source and pays the fee; when it
// is a different party, the configured signer stays the source (it pays the fee
// and owns the consumed sequence number) and the acting party signs its own
// Soroban auth entry. That second form needs a *KeypairSigner, exactly like the
// approval paths, because the auth entry is signed locally.
func (c *Client) authorizedSigners(actor Signer) ([]Signer, error) {
	resolved, err := c.actorSigner(actor)
	if err != nil {
		return nil, err
	}
	if c.signer == nil || c.signer.Address() == resolved.Address() {
		return []Signer{resolved}, nil
	}
	return []Signer{c.signer, resolved}, nil
}

// executeAuthorized runs a call whose contract authorization comes from actor
// (nil means the configured signer) and returns its result.
func (c *Client) executeAuthorized(ctx context.Context, method string, args []xdr.ScVal, actor Signer) (TxResult, error) {
	signers, err := c.authorizedSigners(actor)
	if err != nil {
		return TxResult{}, err
	}
	_, result, err := c.execute(ctx, method, args, signers)
	return result, err
}

func (c *Client) invokeOperation(method string, args []xdr.ScVal) txnbuild.InvokeHostFunction {
	return txnbuild.InvokeHostFunction{
		HostFunction: xdr.HostFunction{
			Type: xdr.HostFunctionTypeHostFunctionTypeInvokeContract,
			InvokeContract: &xdr.InvokeContractArgs{
				ContractAddress: c.contractAddress,
				FunctionName:    xdr.ScSymbol(method),
				Args:            args,
			},
		},
	}
}

func (c *Client) newTransaction(sourceAccount string, sequence int64, op *txnbuild.InvokeHostFunction) (*txnbuild.Transaction, error) {
	return txnbuild.NewTransaction(txnbuild.TransactionParams{
		SourceAccount: &txnbuild.SimpleAccount{
			AccountID: sourceAccount,
			Sequence:  sequence,
		},
		IncrementSequenceNum: true,
		Operations:           []txnbuild.Operation{op},
		BaseFee:              txnbuild.MinBaseFee,
		Preconditions: txnbuild.Preconditions{
			TimeBounds: txnbuild.NewTimeout(int64(c.txTimeout / time.Second)),
		},
	})
}

func (c *Client) simulate(ctx context.Context, tx *txnbuild.Transaction) (protocol.SimulateTransactionResponse, error) {
	envelope, err := tx.Base64()
	if err != nil {
		return protocol.SimulateTransactionResponse{}, fmt.Errorf("escrow: encode transaction for simulation: %w", err)
	}
	response, err := c.rpc.SimulateTransaction(ctx, protocol.SimulateTransactionRequest{Transaction: envelope})
	if err != nil {
		return protocol.SimulateTransactionResponse{}, fmt.Errorf("escrow: simulate transaction: %w", err)
	}
	if response.Error != "" {
		return protocol.SimulateTransactionResponse{}, parseSimulationError(response.Error)
	}
	return response, nil
}

// readInvoke simulates a read-only contract call and returns its ScVal result.
func (c *Client) readInvoke(ctx context.Context, method string, args []xdr.ScVal) (xdr.ScVal, error) {
	signer, err := c.requireSigner()
	if err != nil {
		return xdr.ScVal{}, err
	}
	account, err := c.rpc.LoadAccount(ctx, signer.Address())
	if err != nil {
		return xdr.ScVal{}, fmt.Errorf("escrow: load source account: %w", err)
	}
	sequence, err := account.GetSequenceNumber()
	if err != nil {
		return xdr.ScVal{}, fmt.Errorf("escrow: read source account sequence: %w", err)
	}
	op := c.invokeOperation(method, args)
	tx, err := c.newTransaction(signer.Address(), sequence, &op)
	if err != nil {
		return xdr.ScVal{}, fmt.Errorf("escrow: build transaction: %w", err)
	}
	simulation, err := c.simulate(ctx, tx)
	if err != nil {
		return xdr.ScVal{}, err
	}
	if len(simulation.Results) == 0 || simulation.Results[0].ReturnValueXDR == nil {
		return xdr.ScVal{}, fmt.Errorf("%w: simulation returned no value for %s", ErrSimulationFailed, method)
	}
	var value xdr.ScVal
	if err := xdr.SafeUnmarshalBase64(*simulation.Results[0].ReturnValueXDR, &value); err != nil {
		return xdr.ScVal{}, fmt.Errorf("escrow: decode %s result: %w", method, err)
	}
	return value, nil
}

// GetStatus returns the current status of escrowID. A missing escrow is
// returned as ErrNotFound (errors.As-able to *ContractError).
func (c *Client) GetStatus(ctx context.Context, escrowID uint64) (EscrowStatus, error) {
	value, err := c.readInvoke(ctx, "get_status", []xdr.ScVal{scvU64(escrowID)})
	if err != nil {
		return 0, err
	}
	return decodeStatus(value)
}

// GetEscrow returns the full stored record for escrowID.
func (c *Client) GetEscrow(ctx context.Context, escrowID uint64) (Escrow, error) {
	value, err := c.readInvoke(ctx, "get_escrow", []xdr.ScVal{scvU64(escrowID)})
	if err != nil {
		return Escrow{}, err
	}
	return decodeEscrow(value)
}

// CreateEscrow creates a single-releaser escrow. The configured signer is the
// transaction source and must be the payer (or Payer must be left empty).
func (c *Client) CreateEscrow(ctx context.Context, params CreateEscrowParams) (CreateEscrowResult, error) {
	signer, err := c.requireSigner()
	if err != nil {
		return CreateEscrowResult{}, err
	}
	payer := params.Payer
	if payer == "" {
		payer = signer.Address()
	}
	if payer != signer.Address() {
		return CreateEscrowResult{}, fmt.Errorf("%w: Payer must match the configured signer %q", ErrUnsupportedAuthorization, signer.Address())
	}
	args, err := createEscrowArgs(payer, params.Payee, params.Token, params.Amount, params.ConditionRef, []string{params.Releaser}, 1, params.RefundAfter, params.RefundTo, params.NotifyPayee, false)
	if err != nil {
		return CreateEscrowResult{}, err
	}
	return c.executeCreate(ctx, "create_escrow", args)
}

// CreateEscrowWithReleasers creates an M-of-N escrow (1..10 distinct releasers,
// 1 <= threshold <= len(releasers)).
func (c *Client) CreateEscrowWithReleasers(ctx context.Context, params CreateEscrowWithReleasersParams) (CreateEscrowResult, error) {
	signer, err := c.requireSigner()
	if err != nil {
		return CreateEscrowResult{}, err
	}
	payer := params.Payer
	if payer == "" {
		payer = signer.Address()
	}
	if payer != signer.Address() {
		return CreateEscrowResult{}, fmt.Errorf("%w: Payer must match the configured signer %q", ErrUnsupportedAuthorization, signer.Address())
	}
	args, err := createEscrowArgs(payer, params.Payee, params.Token, params.Amount, params.ConditionRef, params.Releasers, params.Threshold, params.RefundAfter, params.RefundTo, params.NotifyPayee, true)
	if err != nil {
		return CreateEscrowResult{}, err
	}
	return c.executeCreate(ctx, "create_escrow_with_releasers", args)
}

// CreateEscrowWithReleaseTime creates a single-releaser escrow with a
// time-locked release (create_escrow_release_time). The release cannot
// occur before the specified ledger timestamp.
func (c *Client) CreateEscrowWithReleaseTime(ctx context.Context, params CreateEscrowWithReleaseTimeParams) (CreateEscrowResult, error) {
	signer, err := c.requireSigner()
	if err != nil {
		return CreateEscrowResult{}, err
	}
	payer := params.Payer
	if payer == "" {
		payer = signer.Address()
	}
	if payer != signer.Address() {
		return CreateEscrowResult{}, fmt.Errorf("%w: Payer must match the configured signer %q", ErrUnsupportedAuthorization, signer.Address())
	}
	args, err := createEscrowWithReleaseTimeArgs(payer, params.Payee, params.Token, params.Amount, params.ConditionRef, params.Releaser, params.RefundAfter, params.RefundTo, params.ReleaseNotBefore, params.NotifyPayee)
	if err != nil {
		return CreateEscrowResult{}, err
	}
	return c.executeCreate(ctx, "create_escrow_release_time", args)
}

// createEscrowWithReleaseTimeArgs builds the arguments for
// create_escrow_release_time (which includes release_not_before).
func createEscrowWithReleaseTimeArgs(payer, payee, token string, amount *big.Int, conditionRef string, releaser string, refundAfter *uint64, refundTo *string, releaseNotBefore *uint64, notifyPayee bool) ([]xdr.ScVal, error) {
	if payee == "" {
		return nil, fmt.Errorf("%w: Payee is required", ErrInvalidArgument)
	}
	if token == "" {
		return nil, fmt.Errorf("%w: Token is required", ErrInvalidArgument)
	}
	if amount == nil || amount.Sign() <= 0 {
		return nil, fmt.Errorf("%w: amount must be positive", ErrInvalidArgument)
	}
	if amount.Cmp(maxI128) > 0 {
		return nil, fmt.Errorf("%w: amount exceeds the i128 maximum", ErrInvalidArgument)
	}
	if len([]byte(conditionRef)) > maxConditionRefLength {
		return nil, fmt.Errorf("%w: ConditionRef is %d bytes, maximum is %d", ErrInvalidArgument, len([]byte(conditionRef)), maxConditionRefLength)
	}

	payerVal, err := scvAddress(payer)
	if err != nil {
		return nil, err
	}
	payeeVal, err := scvAddress(payee)
	if err != nil {
		return nil, err
	}
	tokenVal, err := scvAddress(token)
	if err != nil {
		return nil, err
	}
	amountVal, err := scvI128(amount)
	if err != nil {
		return nil, err
	}
	releaserVal, err := scvAddress(releaser)
	if err != nil {
		return nil, err
	}
	refundToVal, err := scvOptionAddress(refundTo)
	if err != nil {
		return nil, err
	}

	args := []xdr.ScVal{
		payerVal,
		payeeVal,
		tokenVal,
		amountVal,
		scvString(conditionRef),
		releaserVal,
		scvOptionU64(refundAfter),
		scvBool(notifyPayee),
		refundToVal,
		scvOptionU64(releaseNotBefore),
		// fee_recipient, fee_bps (docs/adr/0010): this SDK does not yet
		// expose the optional protocol fee, so always send None (no fee).
		scvVoid(),
		scvVoid(),
	}
	return args, nil
}

// CreateEscrowWithAcceptance creates a single-releaser escrow with the optional
// payee-acceptance gate (`create_escrow_with_acceptance`, issue #25). With
// RequiresAcceptance true, `release` additionally waits for the payee's Accept
// call, and the payer may Cancel while the payee has not accepted. The payer
// authorizes creation and must be the configured signer.
func (c *Client) CreateEscrowWithAcceptance(ctx context.Context, params CreateEscrowWithAcceptanceParams) (CreateEscrowResult, error) {
	signer, err := c.requireSigner()
	if err != nil {
		return CreateEscrowResult{}, err
	}
	payer := params.Payer
	if payer == "" {
		payer = signer.Address()
	}
	if payer != signer.Address() {
		return CreateEscrowResult{}, fmt.Errorf("%w: Payer must match the configured signer %q", ErrUnsupportedAuthorization, signer.Address())
	}
	args, err := createEscrowWithAcceptanceArgs(payer, params.Payee, params.Token, params.Amount, params.ConditionRef, params.Releaser, params.RefundAfter, params.RequiresAcceptance, params.RefundTo)
	if err != nil {
		return CreateEscrowResult{}, err
	}
	return c.executeCreate(ctx, "create_escrow_with_acceptance", args)
}

// createEscrowWithAcceptanceArgs builds the arguments for
// create_escrow_with_acceptance. The contract records no protocol fee and no
// callback flag on this entry point, and requires_acceptance takes the place
// of create_escrow's notify_payee argument.
func createEscrowWithAcceptanceArgs(payer, payee, token string, amount *big.Int, conditionRef, releaser string, refundAfter *uint64, requiresAcceptance bool, refundTo *string) ([]xdr.ScVal, error) {
	if payee == "" {
		return nil, fmt.Errorf("%w: Payee is required", ErrInvalidArgument)
	}
	if token == "" {
		return nil, fmt.Errorf("%w: Token is required", ErrInvalidArgument)
	}
	if amount == nil || amount.Sign() <= 0 {
		return nil, fmt.Errorf("%w: amount must be positive", ErrInvalidArgument)
	}
	if amount.Cmp(maxI128) > 0 {
		return nil, fmt.Errorf("%w: amount exceeds the i128 maximum", ErrInvalidArgument)
	}
	if len([]byte(conditionRef)) > maxConditionRefLength {
		return nil, fmt.Errorf("%w: ConditionRef is %d bytes, maximum is %d", ErrInvalidArgument, len([]byte(conditionRef)), maxConditionRefLength)
	}

	payerVal, err := scvAddress(payer)
	if err != nil {
		return nil, err
	}
	payeeVal, err := scvAddress(payee)
	if err != nil {
		return nil, err
	}
	tokenVal, err := scvAddress(token)
	if err != nil {
		return nil, err
	}
	amountVal, err := scvI128(amount)
	if err != nil {
		return nil, err
	}
	releaserVal, err := scvAddress(releaser)
	if err != nil {
		return nil, err
	}
	refundToVal, err := scvOptionAddress(refundTo)
	if err != nil {
		return nil, err
	}
	return []xdr.ScVal{
		payerVal,
		payeeVal,
		tokenVal,
		amountVal,
		scvString(conditionRef),
		releaserVal,
		scvOptionU64(refundAfter),
		scvBool(requiresAcceptance),
		refundToVal,
	}, nil
}

// Accept records the payee's acceptance on an escrow created with
// RequiresAcceptance (contract `accept`, issue #25). The payee authorizes it;
// pass the payee's signer when it is not Config.Signer. A second accept fails
// with ErrAlreadyAccepted, an escrow without the gate with
// ErrAcceptanceNotConfigured, and a payee that is not the stored one with
// ErrUnauthorized.
func (c *Client) Accept(ctx context.Context, escrowID uint64, payee Signer) (TxResult, error) {
	actor, err := c.actorSigner(payee)
	if err != nil {
		return TxResult{}, err
	}
	args, err := acceptArgs(escrowID, actor.Address())
	if err != nil {
		return TxResult{}, err
	}
	return c.executeAuthorized(ctx, "accept", args, payee)
}

func acceptArgs(escrowID uint64, payee string) ([]xdr.ScVal, error) {
	payeeVal, err := scvAddress(payee)
	if err != nil {
		return nil, err
	}
	return []xdr.ScVal{scvU64(escrowID), payeeVal}, nil
}

// Cancel lets the payer take the funds back before the payee accepts (contract
// `cancel`, issue #25). It works only on a Funded escrow created with
// RequiresAcceptance that the payee has not accepted yet; the funds go to the
// stored refund destination and the escrow becomes EscrowStatusCancelled. Pass
// the payer's signer when it is not Config.Signer.
func (c *Client) Cancel(ctx context.Context, escrowID uint64, payer Signer) (TxResult, error) {
	actor, err := c.actorSigner(payer)
	if err != nil {
		return TxResult{}, err
	}
	args, err := cancelArgs(escrowID, actor.Address())
	if err != nil {
		return TxResult{}, err
	}
	return c.executeAuthorized(ctx, "cancel", args, payer)
}

func cancelArgs(escrowID uint64, payer string) ([]xdr.ScVal, error) {
	payerVal, err := scvAddress(payer)
	if err != nil {
		return nil, err
	}
	return []xdr.ScVal{scvU64(escrowID), payerVal}, nil
}

// TransferPayee lets the current payee reassign future payout rights to
// newPayee (contract `transfer_payee`, issue #45). Only the current payee may
// authorize it, only while the escrow is Funded, and newPayee may not be the
// payer or the contract itself (ErrInvalidNewPayee). A notify-payee escrow has
// its callback flag cleared by the transfer (issue #286). This is a wallet
// rotation tool, not key-loss recovery: a payee who lost their key cannot sign
// it.
func (c *Client) TransferPayee(ctx context.Context, escrowID uint64, currentPayee Signer, newPayee string) (TxResult, error) {
	actor, err := c.actorSigner(currentPayee)
	if err != nil {
		return TxResult{}, err
	}
	args, err := transferPayeeArgs(escrowID, actor.Address(), newPayee)
	if err != nil {
		return TxResult{}, err
	}
	return c.executeAuthorized(ctx, "transfer_payee", args, currentPayee)
}

func transferPayeeArgs(escrowID uint64, currentPayee, newPayee string) ([]xdr.ScVal, error) {
	currentVal, err := scvAddress(currentPayee)
	if err != nil {
		return nil, err
	}
	newVal, err := scvAddress(newPayee)
	if err != nil {
		return nil, err
	}
	return []xdr.ScVal{scvU64(escrowID), currentVal, newVal}, nil
}

// CreatePooledEscrow creates a pooled escrow: one agreement funded by many
// contributors (`create_pooled_escrow`, issue #113 and docs/adr/0011). Nothing
// is funded at creation — FundingTarget must be positive, FundingDeadline must
// be a future unix timestamp, and contributors then call Contribute until the
// target is reached (releasable) or the deadline passes below it (failed, so
// every contributor calls ClaimRefund). The creator authorizes creation and
// must be the configured signer.
func (c *Client) CreatePooledEscrow(ctx context.Context, params CreatePooledEscrowParams) (CreateEscrowResult, error) {
	signer, err := c.requireSigner()
	if err != nil {
		return CreateEscrowResult{}, err
	}
	creator := params.Creator
	if creator == "" {
		creator = signer.Address()
	}
	if creator != signer.Address() {
		return CreateEscrowResult{}, fmt.Errorf("%w: Creator must match the configured signer %q", ErrUnsupportedAuthorization, signer.Address())
	}
	args, err := createPooledEscrowArgs(creator, params.Payee, params.Token, params.FundingTarget, params.ConditionRef, params.Releaser, params.FundingDeadline)
	if err != nil {
		return CreateEscrowResult{}, err
	}
	return c.executeCreate(ctx, "create_pooled_escrow", args)
}

func createPooledEscrowArgs(creator, payee, token string, fundingTarget *big.Int, conditionRef, releaser string, fundingDeadline uint64) ([]xdr.ScVal, error) {
	if payee == "" {
		return nil, fmt.Errorf("%w: Payee is required", ErrInvalidArgument)
	}
	if token == "" {
		return nil, fmt.Errorf("%w: Token is required", ErrInvalidArgument)
	}
	if fundingTarget == nil || fundingTarget.Sign() <= 0 {
		return nil, fmt.Errorf("%w: FundingTarget must be positive", ErrInvalidArgument)
	}
	if fundingTarget.Cmp(maxI128) > 0 {
		return nil, fmt.Errorf("%w: FundingTarget exceeds the i128 maximum", ErrInvalidArgument)
	}
	if len([]byte(conditionRef)) > maxConditionRefLength {
		return nil, fmt.Errorf("%w: ConditionRef is %d bytes, maximum is %d", ErrInvalidArgument, len([]byte(conditionRef)), maxConditionRefLength)
	}
	if fundingDeadline == 0 {
		return nil, fmt.Errorf("%w: FundingDeadline is required", ErrInvalidArgument)
	}

	creatorVal, err := scvAddress(creator)
	if err != nil {
		return nil, err
	}
	payeeVal, err := scvAddress(payee)
	if err != nil {
		return nil, err
	}
	tokenVal, err := scvAddress(token)
	if err != nil {
		return nil, err
	}
	targetVal, err := scvI128(fundingTarget)
	if err != nil {
		return nil, err
	}
	releaserVal, err := scvAddress(releaser)
	if err != nil {
		return nil, err
	}
	return []xdr.ScVal{
		creatorVal,
		payeeVal,
		tokenVal,
		targetVal,
		scvString(conditionRef),
		releaserVal,
		scvU64(fundingDeadline),
	}, nil
}

// Contribute adds amount to a pooled escrow (`contribute`, issue #113). It is
// permissionless before the funding deadline, but an amount past the target is
// rejected (ErrFundingTargetReached) rather than accepted, and the payer's own
// signature is required — pass that signer when it is not Config.Signer.
func (c *Client) Contribute(ctx context.Context, escrowID uint64, payer Signer, amount *big.Int) (TxResult, error) {
	actor, err := c.actorSigner(payer)
	if err != nil {
		return TxResult{}, err
	}
	args, err := contributeArgs(escrowID, actor.Address(), amount)
	if err != nil {
		return TxResult{}, err
	}
	return c.executeAuthorized(ctx, "contribute", args, payer)
}

func contributeArgs(escrowID uint64, payer string, amount *big.Int) ([]xdr.ScVal, error) {
	if amount == nil || amount.Sign() <= 0 {
		return nil, fmt.Errorf("%w: amount must be positive", ErrInvalidArgument)
	}
	payerVal, err := scvAddress(payer)
	if err != nil {
		return nil, err
	}
	amountVal, err := scvI128(amount)
	if err != nil {
		return nil, err
	}
	return []xdr.ScVal{scvU64(escrowID), payerVal, amountVal}, nil
}

// ClaimRefund pulls a contributor's own record back out of a failed pooled
// round (`claim_refund`, issue #113): the funding deadline passed with the
// target unmet, so each contributor claims exactly what they contributed, once
// (ErrAlreadyRefunded afterwards). Before the deadline it fails
// ErrRefundNotOpen; on a fully funded round ErrFundingTargetReached; with no
// record ErrNoContribution. Pass the contributor's signer when it is not
// Config.Signer.
func (c *Client) ClaimRefund(ctx context.Context, escrowID uint64, contributor Signer) (TxResult, error) {
	actor, err := c.actorSigner(contributor)
	if err != nil {
		return TxResult{}, err
	}
	args, err := claimRefundArgs(escrowID, actor.Address())
	if err != nil {
		return TxResult{}, err
	}
	return c.executeAuthorized(ctx, "claim_refund", args, contributor)
}

func claimRefundArgs(escrowID uint64, contributor string) ([]xdr.ScVal, error) {
	contributorVal, err := scvAddress(contributor)
	if err != nil {
		return nil, err
	}
	return []xdr.ScVal{scvU64(escrowID), contributorVal}, nil
}

// GetPooled returns a pooled escrow's immutable funding configuration. Combine
// it with GetEscrow's Amount to classify the round: Amount == FundingTarget is
// releasable, and now >= FundingDeadline with Amount < FundingTarget means the
// round failed and ClaimRefund is open. A failed round still reports Funded
// from GetStatus, because status describes settlement. A non-pooled or unknown
// id fails ErrNotPooled.
func (c *Client) GetPooled(ctx context.Context, escrowID uint64) (PooledData, error) {
	value, err := c.readInvoke(ctx, "get_pooled", []xdr.ScVal{scvU64(escrowID)})
	if err != nil {
		return PooledData{}, err
	}
	return decodePooledData(value)
}

// GetContribution returns one address's record on a pooled escrow, or nil when
// the address never contributed (the contract's Option<Contribution>). An
// unknown id fails ErrNotFound and a non-pooled escrow fails ErrNotPooled, so
// the two are distinguishable.
func (c *Client) GetContribution(ctx context.Context, escrowID uint64, contributor string) (*Contribution, error) {
	contributorVal, err := scvAddress(contributor)
	if err != nil {
		return nil, err
	}
	value, err := c.readInvoke(ctx, "get_contribution", []xdr.ScVal{scvU64(escrowID), contributorVal})
	if err != nil {
		return nil, err
	}
	return decodeOptionContribution(value)
}

// CreateEscrows creates many escrows in as few transactions as the contract
// allows (`create_escrows`, issue #344): up to MaxBatchSize items per call, in
// input order, with the ids returned in the same order. The payer authorizes
// the whole batch once and must be the configured signer.
//
// Each transaction is atomic, the batch across them is not: if a later chunk
// fails, the returned result describes the escrows the earlier chunks already
// created and the error is that chunk's failure. Every item is validated
// client-side before the first transaction, so a bad item never leaves earlier
// chunks committed. An empty item list returns an empty result and sends
// nothing.
func (c *Client) CreateEscrows(ctx context.Context, params CreateEscrowsParams) (CreateEscrowsResult, error) {
	signer, err := c.requireSigner()
	if err != nil {
		return CreateEscrowsResult{}, err
	}
	payer := params.Payer
	if payer == "" {
		payer = signer.Address()
	}
	if payer != signer.Address() {
		return CreateEscrowsResult{}, fmt.Errorf("%w: Payer must match the configured signer %q", ErrUnsupportedAuthorization, signer.Address())
	}
	for i, item := range params.Items {
		if err := validateCreateItem(item); err != nil {
			return CreateEscrowsResult{}, fmt.Errorf("escrow: item %d: %w", i, err)
		}
	}

	result := CreateEscrowsResult{}
	for start := 0; start < len(params.Items); start += MaxBatchSize {
		end := start + MaxBatchSize
		if end > len(params.Items) {
			end = len(params.Items)
		}
		chunk := params.Items[start:end]
		args, err := createEscrowsArgs(payer, chunk)
		if err != nil {
			return result, err
		}
		returnValue, executed, err := c.execute(ctx, "create_escrows", args, []Signer{signer})
		if err != nil {
			return result, err
		}
		if returnValue == nil {
			return result, fmt.Errorf("%w: create_escrows returned no escrow ids", ErrTransactionFailed)
		}
		ids, err := decodeU64Vec(*returnValue)
		if err != nil {
			return result, err
		}
		if len(ids) != len(chunk) {
			return result, fmt.Errorf("%w: create_escrows returned %d ids for %d items", ErrTransactionFailed, len(ids), len(chunk))
		}
		result.EscrowIDs = append(result.EscrowIDs, ids...)
		result.TxHashes = append(result.TxHashes, executed.TxHash)
	}
	return result, nil
}

// validateCreateItem mirrors the contract's per-item validation so a bad item
// is reported before any transaction is sent.
func validateCreateItem(item CreateItem) error {
	if item.Payee == "" {
		return fmt.Errorf("%w: Payee is required", ErrInvalidArgument)
	}
	if item.Token == "" {
		return fmt.Errorf("%w: Token is required", ErrInvalidArgument)
	}
	if item.Amount == nil || item.Amount.Sign() <= 0 {
		return fmt.Errorf("%w: amount must be positive", ErrInvalidArgument)
	}
	if item.Amount.Cmp(maxI128) > 0 {
		return fmt.Errorf("%w: amount exceeds the i128 maximum", ErrInvalidArgument)
	}
	if len([]byte(item.ConditionRef)) > maxConditionRefLength {
		return fmt.Errorf("%w: ConditionRef is %d bytes, maximum is %d", ErrInvalidArgument, len([]byte(item.ConditionRef)), maxConditionRefLength)
	}
	if _, err := parseScAddress(item.Releaser); err != nil {
		return err
	}
	return nil
}

func createEscrowsArgs(payer string, items []CreateItem) ([]xdr.ScVal, error) {
	payerVal, err := scvAddress(payer)
	if err != nil {
		return nil, err
	}
	values := make([]xdr.ScVal, 0, len(items))
	for i, item := range items {
		if err := validateCreateItem(item); err != nil {
			return nil, fmt.Errorf("escrow: item %d: %w", i, err)
		}
		value, err := createItemScVal(item)
		if err != nil {
			return nil, fmt.Errorf("escrow: item %d: %w", i, err)
		}
		values = append(values, value)
	}
	return []xdr.ScVal{payerVal, scvVec(values)}, nil
}

// SettleMany releases or refunds many escrows in as few transactions as the
// contract allows (`settle_many`, issue #344 and docs/adr/0012): up to
// MaxSettleOps operations per call, with one result per op in input order. The
// caller authorizes each transaction once and must be the configured signer;
// per-op authority still comes from each escrow's own releaser set, so an
// escrow belonging to someone else is rejected (ErrUnauthorized) and left
// untouched.
//
// A per-op rejection is never returned as the function's error: it appears in
// Results for that op. The returned error is the transaction-level failure that
// reverts a whole chunk — an opted-in payee callback that failed
// (ErrCallbackFailed) is the case the contract documents — and Results then
// covers only the earlier chunks that already committed. An empty op list
// returns an empty result and sends nothing.
func (c *Client) SettleMany(ctx context.Context, ops []SettleOp) (SettleManyResult, error) {
	signer, err := c.requireSigner()
	if err != nil {
		return SettleManyResult{}, err
	}
	for i, op := range ops {
		if !op.Action.IsValid() {
			return SettleManyResult{}, fmt.Errorf("%w: op %d has unknown action %d", ErrInvalidArgument, i, uint32(op.Action))
		}
	}

	result := SettleManyResult{}
	for start := 0; start < len(ops); start += MaxSettleOps {
		end := start + MaxSettleOps
		if end > len(ops) {
			end = len(ops)
		}
		chunk := ops[start:end]
		args, err := settleManyArgs(signer.Address(), chunk)
		if err != nil {
			return result, err
		}
		returnValue, executed, err := c.execute(ctx, "settle_many", args, []Signer{signer})
		if err != nil {
			return result, err
		}
		if returnValue == nil {
			return result, fmt.Errorf("%w: settle_many returned no results", ErrTransactionFailed)
		}
		perOp, err := decodeSettleResults(*returnValue)
		if err != nil {
			return result, err
		}
		if len(perOp) != len(chunk) {
			return result, fmt.Errorf("%w: settle_many returned %d results for %d ops", ErrTransactionFailed, len(perOp), len(chunk))
		}
		for i, opErr := range perOp {
			result.Results = append(result.Results, SettleOpResult{EscrowID: chunk[i].EscrowID, Action: chunk[i].Action, Err: opErr})
		}
		result.TxHashes = append(result.TxHashes, executed.TxHash)
	}
	return result, nil
}

func settleManyArgs(caller string, ops []SettleOp) ([]xdr.ScVal, error) {
	callerVal, err := scvAddress(caller)
	if err != nil {
		return nil, err
	}
	values := make([]xdr.ScVal, 0, len(ops))
	for i, op := range ops {
		value, err := settleOpScVal(op)
		if err != nil {
			return nil, fmt.Errorf("escrow: op %d: %w", i, err)
		}
		values = append(values, value)
	}
	return []xdr.ScVal{callerVal, scvVec(values)}, nil
}

// createEscrowArgs builds the arguments for either create_escrow
// (useReleaserVec=false, which takes a single releaser) or
// create_escrow_with_releasers (true, which always takes a vec + threshold,
// even for a one-releaser escrow).
func createEscrowArgs(payer, payee, token string, amount *big.Int, conditionRef string, releasers []string, threshold uint32, refundAfter *uint64, refundTo *string, notifyPayee bool, useReleaserVec bool) ([]xdr.ScVal, error) {
	if payee == "" {
		return nil, fmt.Errorf("%w: Payee is required", ErrInvalidArgument)
	}
	if token == "" {
		return nil, fmt.Errorf("%w: Token is required", ErrInvalidArgument)
	}
	if amount == nil || amount.Sign() <= 0 {
		return nil, fmt.Errorf("%w: amount must be positive", ErrInvalidArgument)
	}
	if amount.Cmp(maxI128) > 0 {
		return nil, fmt.Errorf("%w: amount exceeds the i128 maximum", ErrInvalidArgument)
	}
	if len([]byte(conditionRef)) > maxConditionRefLength {
		return nil, fmt.Errorf("%w: ConditionRef is %d bytes, maximum is %d", ErrInvalidArgument, len([]byte(conditionRef)), maxConditionRefLength)
	}
	if len(releasers) == 0 {
		return nil, fmt.Errorf("%w: at least one releaser is required", ErrInvalidArgument)
	}
	if len(releasers) > maxReleasers {
		return nil, fmt.Errorf("%w: at most %d releasers are allowed", ErrInvalidArgument, maxReleasers)
	}
	if threshold < 1 || int(threshold) > len(releasers) {
		return nil, fmt.Errorf("%w: threshold must be between 1 and %d", ErrInvalidArgument, len(releasers))
	}
	seen := make(map[string]struct{}, len(releasers))
	for _, releaser := range releasers {
		if _, ok := seen[releaser]; ok {
			return nil, fmt.Errorf("%w: duplicate releaser %q", ErrInvalidArgument, releaser)
		}
		seen[releaser] = struct{}{}
	}

	payerVal, err := scvAddress(payer)
	if err != nil {
		return nil, err
	}
	payeeVal, err := scvAddress(payee)
	if err != nil {
		return nil, err
	}
	tokenVal, err := scvAddress(token)
	if err != nil {
		return nil, err
	}
	amountVal, err := scvI128(amount)
	if err != nil {
		return nil, err
	}
	releaserVals := make([]xdr.ScVal, 0, len(releasers))
	for _, releaser := range releasers {
		value, err := scvAddress(releaser)
		if err != nil {
			return nil, err
		}
		releaserVals = append(releaserVals, value)
	}
	refundToVal, err := scvOptionAddress(refundTo)
	if err != nil {
		return nil, err
	}
	args := []xdr.ScVal{
		payerVal,
		payeeVal,
		tokenVal,
		amountVal,
		scvString(conditionRef),
	}
	if useReleaserVec {
		args = append(args, scvVec(releaserVals), scvU32(threshold))
	} else {
		args = append(args, releaserVals[0])
	}
	args = append(args, scvOptionU64(refundAfter), scvBool(notifyPayee), refundToVal)
	if !useReleaserVec {
		// create_escrow also takes fee_recipient and fee_bps
		// (docs/adr/0010); create_escrow_with_releasers does not. This SDK
		// does not yet expose the optional protocol fee, so send None (no fee).
		args = append(args, scvVoid(), scvVoid())
	}
	return args, nil
}

func (c *Client) executeCreate(ctx context.Context, method string, args []xdr.ScVal) (CreateEscrowResult, error) {
	signer, err := c.requireSigner()
	if err != nil {
		return CreateEscrowResult{}, err
	}
	returnValue, result, err := c.execute(ctx, method, args, []Signer{signer})
	if err != nil {
		return CreateEscrowResult{}, err
	}
	if returnValue == nil {
		return CreateEscrowResult{}, fmt.Errorf("%w: %s returned no escrow id", ErrTransactionFailed, method)
	}
	escrowID, err := decodeU64(*returnValue)
	if err != nil {
		return CreateEscrowResult{}, fmt.Errorf("escrow: decode escrow id: %w", err)
	}
	return CreateEscrowResult{EscrowID: escrowID, TxHash: result.TxHash}, nil
}

// Release moves the escrow's funds to its payee. The configured signer must be
// the escrow's releaser (and the escrow must have threshold 1).
func (c *Client) Release(ctx context.Context, escrowID uint64) (TxResult, error) {
	signer, err := c.requireSigner()
	if err != nil {
		return TxResult{}, err
	}
	caller, err := scvAddress(signer.Address())
	if err != nil {
		return TxResult{}, err
	}
	_, result, err := c.execute(ctx, "release", []xdr.ScVal{scvU64(escrowID), caller}, []Signer{signer})
	return result, err
}

// Refund returns the escrow's funds to its payer. The configured signer must be
// a releaser, or the refund_after deadline must have passed (then anyone may
// refund, still only to the payer).
func (c *Client) Refund(ctx context.Context, escrowID uint64) (TxResult, error) {
	signer, err := c.requireSigner()
	if err != nil {
		return TxResult{}, err
	}
	caller, err := scvAddress(signer.Address())
	if err != nil {
		return TxResult{}, err
	}
	_, result, err := c.execute(ctx, "refund", []xdr.ScVal{scvU64(escrowID), caller}, []Signer{signer})
	return result, err
}

// TopUp adds funds to a Funded escrow. The configured signer must be its payer.
func (c *Client) TopUp(ctx context.Context, escrowID uint64, amount *big.Int) (TxResult, error) {
	signer, err := c.requireSigner()
	if err != nil {
		return TxResult{}, err
	}
	if amount == nil || amount.Sign() <= 0 {
		return TxResult{}, fmt.Errorf("%w: amount must be positive", ErrInvalidArgument)
	}
	payer, err := scvAddress(signer.Address())
	if err != nil {
		return TxResult{}, err
	}
	amountVal, err := scvI128(amount)
	if err != nil {
		return TxResult{}, err
	}
	_, result, err := c.execute(ctx, "top_up", []xdr.ScVal{scvU64(escrowID), payer, amountVal}, []Signer{signer})
	return result, err
}

// ReleaseWithApprovals settles an M-of-N escrow. The first signer pays the
// transaction fee; every signer's address is placed in the approver list. All
// but the first signer must be a *KeypairSigner so their Soroban auth entries
// can be signed locally.
func (c *Client) ReleaseWithApprovals(ctx context.Context, escrowID uint64, approvers []Signer) (TxResult, error) {
	return c.settleWithApprovals(ctx, "release_with_approvals", escrowID, approvers)
}

// RefundWithApprovals is the M-of-N refund counterpart to ReleaseWithApprovals.
func (c *Client) RefundWithApprovals(ctx context.Context, escrowID uint64, approvers []Signer) (TxResult, error) {
	return c.settleWithApprovals(ctx, "refund_with_approvals", escrowID, approvers)
}

func (c *Client) settleWithApprovals(ctx context.Context, method string, escrowID uint64, approvers []Signer) (TxResult, error) {
	if len(approvers) == 0 {
		return TxResult{}, fmt.Errorf("%w: at least one approver is required", ErrInvalidArgument)
	}
	if len(approvers) > maxReleasers {
		return TxResult{}, fmt.Errorf("%w: at most %d approvers are allowed", ErrInvalidArgument, maxReleasers)
	}
	seen := make(map[string]struct{}, len(approvers))
	values := make([]xdr.ScVal, 0, len(approvers))
	for _, approver := range approvers {
		address, err := scvAddress(approver.Address())
		if err != nil {
			return TxResult{}, err
		}
		if _, ok := seen[approver.Address()]; ok {
			return TxResult{}, fmt.Errorf("%w: duplicate approver %q", ErrInvalidArgument, approver.Address())
		}
		seen[approver.Address()] = struct{}{}
		values = append(values, address)
	}
	_, result, err := c.execute(ctx, method, []xdr.ScVal{scvU64(escrowID), scvVec(values)}, approvers)
	return result, err
}

// execute runs the full Soroban flow: load sequence, build + simulate, apply
// resource data and auth, sign, submit, poll, and decode the return value.
func (c *Client) execute(ctx context.Context, method string, args []xdr.ScVal, signers []Signer) (*xdr.ScVal, TxResult, error) {
	if len(signers) == 0 || signers[0] == nil {
		return nil, TxResult{}, ErrSignerRequired
	}
	source := signers[0]

	account, err := c.rpc.LoadAccount(ctx, source.Address())
	if err != nil {
		return nil, TxResult{}, fmt.Errorf("escrow: load source account: %w", err)
	}
	sequence, err := account.GetSequenceNumber()
	if err != nil {
		return nil, TxResult{}, fmt.Errorf("escrow: read source account sequence: %w", err)
	}

	op := c.invokeOperation(method, args)
	simulationTx, err := c.newTransaction(source.Address(), sequence, &op)
	if err != nil {
		return nil, TxResult{}, fmt.Errorf("escrow: build transaction: %w", err)
	}
	simulation, err := c.simulate(ctx, simulationTx)
	if err != nil {
		return nil, TxResult{}, err
	}
	if simulation.TransactionDataXDR == "" {
		return nil, TxResult{}, fmt.Errorf("%w: simulation returned no Soroban transaction data", ErrSimulationFailed)
	}

	var transactionData xdr.SorobanTransactionData
	if err := xdr.SafeUnmarshalBase64(simulation.TransactionDataXDR, &transactionData); err != nil {
		return nil, TxResult{}, fmt.Errorf("%w: decode Soroban transaction data: %v", ErrSimulationFailed, err)
	}
	authEntries, err := c.prepareAuthEntries(simulation, signers, source.Address())
	if err != nil {
		return nil, TxResult{}, err
	}

	op.Auth = authEntries
	op.Ext = xdr.TransactionExt{
		V:           1,
		SorobanData: &transactionData,
	}
	transaction, err := c.newTransaction(source.Address(), sequence, &op)
	if err != nil {
		return nil, TxResult{}, fmt.Errorf("escrow: rebuild transaction with simulation data: %w", err)
	}
	unsignedXDR, err := transaction.Base64()
	if err != nil {
		return nil, TxResult{}, fmt.Errorf("escrow: encode transaction: %w", err)
	}
	signedXDR, err := source.SignTransaction(ctx, unsignedXDR)
	if err != nil {
		if ctx.Err() != nil {
			return nil, TxResult{}, ctx.Err()
		}
		return nil, TxResult{}, fmt.Errorf("%w: %v", ErrWalletRejected, err)
	}

	sent, err := c.rpc.SendTransaction(ctx, protocol.SendTransactionRequest{Transaction: signedXDR})
	if err != nil {
		return nil, TxResult{}, fmt.Errorf("escrow: send transaction: %w", err)
	}
	txHash := sent.Hash
	if txHash == "" {
		txHash, err = transaction.HashHex(c.networkPassphrase)
		if err != nil {
			return nil, TxResult{}, fmt.Errorf("escrow: hash transaction: %w", err)
		}
	}
	if sent.Status == "ERROR" {
		return nil, TxResult{}, errorFromSendFailure(sent)
	}

	pollCtx, cancel := context.WithTimeout(ctx, c.pollTimeout)
	defer cancel()
	pollOptions := rpcclient.NewPollTransactionOptions().WithInitialInterval(c.pollInterval)
	final, err := c.rpc.PollTransactionWithOptions(pollCtx, txHash, pollOptions)
	if err != nil {
		if pollCtx.Err() != nil {
			return nil, TxResult{}, fmt.Errorf("%w: %s (tx %s)", ErrTimeout, method, txHash)
		}
		return nil, TxResult{}, fmt.Errorf("escrow: poll transaction: %w", err)
	}
	if final.Status != protocol.TransactionStatusSuccess {
		return nil, TxResult{}, errorFromTransaction(final)
	}

	returnValue, err := returnValueFromMeta(final.ResultMetaXDR)
	if err != nil {
		return nil, TxResult{}, err
	}
	return returnValue, TxResult{TxHash: txHash, Ledger: final.Ledger}, nil
}

func (c *Client) prepareAuthEntries(simulation protocol.SimulateTransactionResponse, signers []Signer, sourceAddress string) ([]xdr.SorobanAuthorizationEntry, error) {
	if len(simulation.Results) == 0 || simulation.Results[0].AuthXDR == nil {
		return nil, nil
	}

	signersByAddress := make(map[string]Signer, len(signers))
	for _, signer := range signers {
		if signer != nil {
			signersByAddress[signer.Address()] = signer
		}
	}
	expirationLedger := simulation.LatestLedger + 100

	entries := make([]xdr.SorobanAuthorizationEntry, 0, len(*simulation.Results[0].AuthXDR))
	for _, raw := range *simulation.Results[0].AuthXDR {
		var entry xdr.SorobanAuthorizationEntry
		if err := xdr.SafeUnmarshalBase64(raw, &entry); err != nil {
			return nil, fmt.Errorf("%w: decode auth entry: %v", ErrSimulationFailed, err)
		}

		switch entry.Credentials.Type {
		case xdr.SorobanCredentialsTypeSorobanCredentialsSourceAccount:
			// Already satisfied by the transaction envelope signature.
		case xdr.SorobanCredentialsTypeSorobanCredentialsAddress:
			if entry.Credentials.Address == nil {
				return nil, fmt.Errorf("%w: address auth credentials missing", ErrUnsupportedAuthorization)
			}
			address, err := scAddressString(entry.Credentials.Address.Address)
			if err != nil {
				return nil, err
			}
			if address == sourceAddress {
				// The source account's envelope signature authorizes this entry;
				// using source-account credentials works for any Signer
				// implementation (including external wallets).
				entry.Credentials = sourceAccountCredentials()
				break
			}
			signer, ok := signersByAddress[address]
			if !ok {
				return nil, fmt.Errorf("%w: no signer for address %s", ErrUnsupportedAuthorization, address)
			}
			keypairSigner, ok := signer.(*KeypairSigner)
			if !ok {
				return nil, fmt.Errorf("%w: address %s requires an auth-entry signature; use *KeypairSigner", ErrUnsupportedAuthorization, address)
			}
			if err := signSorobanAuthEntry(&entry, keypairSigner.keypair, c.networkPassphrase, expirationLedger); err != nil {
				return nil, err
			}
		default:
			return nil, fmt.Errorf("%w: credential type %s", ErrUnsupportedAuthorization, entry.Credentials.Type)
		}
		entries = append(entries, entry)
	}
	return entries, nil
}
