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
	}
	return args, nil
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
