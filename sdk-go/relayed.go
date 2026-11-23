package escrow

import (
	"context"
	"encoding/json"
	"fmt"

	protocol "github.com/stellar/go-stellar-sdk/protocols/rpc"
	"github.com/stellar/go-stellar-sdk/strkey"
	"github.com/stellar/go-stellar-sdk/xdr"
)

// RelayedAuthorizationTTLLedgers is how long (in ledgers) a relayed
// authorization's contract auth entry stays valid. It matches
// RELAYED_AUTH_TTL_LEDGERS in the TypeScript SDK.
const RelayedAuthorizationTTLLedgers uint32 = 10

// SettlementMethod names the settlement call a relayed authorization covers.
type SettlementMethod string

const (
	// SettlementRelease authorizes `release`.
	SettlementRelease SettlementMethod = "release"
	// SettlementRefund authorizes `refund`.
	SettlementRefund SettlementMethod = "refund"
)

func (s SettlementMethod) valid() bool {
	return s == SettlementRelease || s == SettlementRefund
}

// RelayedAuthorization is a portable, short-lived authorization for one
// release or refund, produced by AuthorizeRelease/AuthorizeRefund and submitted
// by a different account with SubmitRelayed.
//
// Transaction is the JSON form of the simulated transaction. It is the same
// format the TypeScript SDK uses for RelayedAuthorization.transaction
// (AssembledTransaction.toJSON()), so an authorization can be produced by one
// SDK and submitted by the other:
//
//	{"method":"release","tx":"<unsigned envelope XDR>",
//	 "simulationResult":{"auth":["<SorobanAuthorizationEntry XDR>"],"retval":"<ScVal XDR>"},
//	 "simulationTransactionData":"<SorobanTransactionData XDR>"}
//
// Keep it private: the signed auth entry lets the relayer submit the settlement
// until ExpiresAtLedger.
type RelayedAuthorization struct {
	Transaction     string `json:"transaction"`
	ExpiresAtLedger uint32 `json:"expiresAtLedger"`
}

// assembledTransactionJSON is the wire format described on RelayedAuthorization.
type assembledTransactionJSON struct {
	Method           string `json:"method"`
	Tx               string `json:"tx"`
	SimulationResult struct {
		Auth   []string `json:"auth"`
		Retval string   `json:"retval"`
	} `json:"simulationResult"`
	SimulationTransactionData string `json:"simulationTransactionData"`
}

// AuthorizeRelease simulates `release` with relayer as the transaction source,
// has the configured signer (the escrow's releaser) sign only its short-lived
// contract auth entry, and returns the authorization for relayer to submit.
// No envelope signature is collected, so the releaser never pays a fee.
func (c *Client) AuthorizeRelease(ctx context.Context, escrowID uint64, relayer string) (RelayedAuthorization, error) {
	return c.authorizeSettlement(ctx, SettlementRelease, escrowID, relayer)
}

// AuthorizeRefund is the `refund` counterpart to AuthorizeRelease, with the
// same lifetime and privacy rules.
func (c *Client) AuthorizeRefund(ctx context.Context, escrowID uint64, relayer string) (RelayedAuthorization, error) {
	return c.authorizeSettlement(ctx, SettlementRefund, escrowID, relayer)
}

func (c *Client) authorizeSettlement(ctx context.Context, settlement SettlementMethod, escrowID uint64, relayer string) (RelayedAuthorization, error) {
	if !settlement.valid() {
		return RelayedAuthorization{}, fmt.Errorf("%w: unknown settlement %q", ErrInvalidArgument, settlement)
	}
	signer, err := c.requireSigner()
	if err != nil {
		return RelayedAuthorization{}, err
	}
	releaser, ok := signer.(*KeypairSigner)
	if !ok {
		return RelayedAuthorization{}, fmt.Errorf("%w: the releaser must be a *KeypairSigner so its auth entry can be signed", ErrUnsupportedAuthorization)
	}
	if !strkey.IsValidEd25519PublicKey(relayer) {
		return RelayedAuthorization{}, fmt.Errorf("%w: relayer %q is not a Stellar account address", ErrInvalidArgument, relayer)
	}
	if relayer == releaser.Address() {
		return RelayedAuthorization{}, fmt.Errorf("%w: relayer must be a different account than the releaser", ErrInvalidArgument)
	}

	account, err := c.rpc.LoadAccount(ctx, relayer)
	if err != nil {
		return RelayedAuthorization{}, fmt.Errorf("escrow: load relayer account: %w", err)
	}
	sequence, err := account.GetSequenceNumber()
	if err != nil {
		return RelayedAuthorization{}, fmt.Errorf("escrow: read relayer sequence: %w", err)
	}
	caller, err := scvAddress(releaser.Address())
	if err != nil {
		return RelayedAuthorization{}, err
	}
	op := c.invokeOperation(string(settlement), []xdr.ScVal{scvU64(escrowID), caller})
	unsigned, err := c.newTransaction(relayer, sequence, &op)
	if err != nil {
		return RelayedAuthorization{}, fmt.Errorf("escrow: build transaction: %w", err)
	}
	simulation, err := c.simulate(ctx, unsigned)
	if err != nil {
		return RelayedAuthorization{}, err
	}
	if simulation.TransactionDataXDR == "" {
		return RelayedAuthorization{}, fmt.Errorf("%w: simulation returned no Soroban transaction data", ErrSimulationFailed)
	}
	if len(simulation.Results) == 0 {
		return RelayedAuthorization{}, fmt.Errorf("%w: simulation returned no result", ErrSimulationFailed)
	}

	latest, err := c.rpc.GetLatestLedger(ctx)
	if err != nil {
		return RelayedAuthorization{}, fmt.Errorf("escrow: get latest ledger: %w", err)
	}
	expiresAt := latest.Sequence + RelayedAuthorizationTTLLedgers

	entries, err := c.relayedAuthEntries(simulation, releaser, relayer, expiresAt)
	if err != nil {
		return RelayedAuthorization{}, err
	}
	encodedEntries := make([]string, 0, len(entries))
	for _, entry := range entries {
		raw, err := xdr.MarshalBase64(entry)
		if err != nil {
			return RelayedAuthorization{}, fmt.Errorf("escrow: encode auth entry: %w", err)
		}
		encodedEntries = append(encodedEntries, raw)
	}

	retval := ""
	if simulation.Results[0].ReturnValueXDR != nil {
		retval = *simulation.Results[0].ReturnValueXDR
	} else {
		retval, err = xdr.MarshalBase64(scvVoid())
		if err != nil {
			return RelayedAuthorization{}, fmt.Errorf("escrow: encode return value: %w", err)
		}
	}

	envelopeXDR, err := unsigned.Base64()
	if err != nil {
		return RelayedAuthorization{}, fmt.Errorf("escrow: encode transaction: %w", err)
	}
	payload := assembledTransactionJSON{
		Method: string(settlement),
		Tx:     envelopeXDR,
	}
	payload.SimulationResult.Auth = encodedEntries
	payload.SimulationResult.Retval = retval
	payload.SimulationTransactionData = simulation.TransactionDataXDR

	encodedJSON, err := json.Marshal(payload)
	if err != nil {
		return RelayedAuthorization{}, fmt.Errorf("escrow: encode relayed authorization: %w", err)
	}
	return RelayedAuthorization{Transaction: string(encodedJSON), ExpiresAtLedger: expiresAt}, nil
}

// relayedAuthEntries resolves one invocation's auth entries for a relay:
// the relayer's own entries become source-account credentials (the envelope
// signature covers them) and the releaser's entry is signed with an explicit
// expiration. Anything else means a party this flow cannot satisfy.
func (c *Client) relayedAuthEntries(simulation protocol.SimulateTransactionResponse, releaser *KeypairSigner, relayer string, expirationLedger uint32) ([]xdr.SorobanAuthorizationEntry, error) {
	if len(simulation.Results) == 0 || simulation.Results[0].AuthXDR == nil {
		return nil, nil
	}
	entries := make([]xdr.SorobanAuthorizationEntry, 0, len(*simulation.Results[0].AuthXDR))
	for _, raw := range *simulation.Results[0].AuthXDR {
		var entry xdr.SorobanAuthorizationEntry
		if err := xdr.SafeUnmarshalBase64(raw, &entry); err != nil {
			return nil, fmt.Errorf("%w: decode auth entry: %v", ErrSimulationFailed, err)
		}
		switch entry.Credentials.Type {
		case xdr.SorobanCredentialsTypeSorobanCredentialsSourceAccount:
			// Already satisfied by the relayer's envelope signature.
		case xdr.SorobanCredentialsTypeSorobanCredentialsAddress:
			if entry.Credentials.Address == nil {
				return nil, fmt.Errorf("%w: address auth credentials missing", ErrUnsupportedAuthorization)
			}
			address, err := scAddressString(entry.Credentials.Address.Address)
			if err != nil {
				return nil, err
			}
			switch address {
			case relayer:
				entry.Credentials = sourceAccountCredentials()
			case releaser.Address():
				if err := signSorobanAuthEntry(&entry, releaser.keypair, c.networkPassphrase, expirationLedger); err != nil {
					return nil, err
				}
			default:
				return nil, fmt.Errorf("%w: settlement requires authorization from %s, which a relay cannot provide", ErrUnsupportedAuthorization, address)
			}
		default:
			return nil, fmt.Errorf("%w: credential type %s", ErrUnsupportedAuthorization, entry.Credentials.Type)
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

// SubmitRelayed signs a relayed authorization's envelope as relayer and
// submits it, returning the settled transaction. The authorization must be for
// the named settlement, must not have expired, must contain exactly one
// invocation of this contract's `release`/`refund`, and must name relayer as
// its source: the relayer pays the fee, and the envelope signature is what
// authorizes its own auth entries.
func (c *Client) SubmitRelayed(ctx context.Context, settlement SettlementMethod, authorization RelayedAuthorization, relayer Signer) (TxResult, error) {
	if !settlement.valid() {
		return TxResult{}, fmt.Errorf("%w: unknown settlement %q", ErrInvalidArgument, settlement)
	}
	if relayer == nil {
		return TxResult{}, ErrSignerRequired
	}
	if authorization.Transaction == "" {
		return TxResult{}, fmt.Errorf("%w: relayed authorization has no transaction", ErrInvalidArgument)
	}
	if authorization.ExpiresAtLedger == 0 {
		return TxResult{}, fmt.Errorf("%w: relayed authorization has no expiry ledger", ErrInvalidArgument)
	}
	var payload assembledTransactionJSON
	if err := json.Unmarshal([]byte(authorization.Transaction), &payload); err != nil {
		return TxResult{}, fmt.Errorf("%w: relayed authorization is not valid JSON: %v", ErrInvalidArgument, err)
	}
	if payload.Method != string(settlement) {
		return TxResult{}, fmt.Errorf(
			"%w: relayed authorization is for %q, not %q", ErrInvalidArgument, payload.Method, settlement)
	}

	latest, err := c.rpc.GetLatestLedger(ctx)
	if err != nil {
		return TxResult{}, fmt.Errorf("escrow: get latest ledger: %w", err)
	}
	if latest.Sequence > authorization.ExpiresAtLedger {
		return TxResult{}, fmt.Errorf(
			"%w: authorization expired at ledger %d, latest is %d",
			ErrAuthorizationExpired, authorization.ExpiresAtLedger, latest.Sequence)
	}

	envelope, err := c.relayedEnvelope(payload, settlement)
	if err != nil {
		return TxResult{}, err
	}
	sourceAccount := envelope.V1.Tx.SourceAccount.ToAccountId()
	if sourceAccount.Address() != relayer.Address() {
		return TxResult{}, fmt.Errorf(
			"%w: authorization must be submitted by its relayer %s, not %s",
			ErrUnsupportedAuthorization, sourceAccount.Address(), relayer.Address())
	}

	xdrText, err := xdr.MarshalBase64(envelope)
	if err != nil {
		return TxResult{}, fmt.Errorf("escrow: encode transaction: %w", err)
	}
	signed, err := relayer.SignTransaction(ctx, xdrText)
	if err != nil {
		if ctx.Err() != nil {
			return TxResult{}, ctx.Err()
		}
		return TxResult{}, fmt.Errorf("%w: %v", ErrWalletRejected, err)
	}
	result, _, err := c.submitEnvelope(ctx, string(settlement), signed)
	return result, err
}

// relayedEnvelope validates a relayed authorization's envelope and applies the
// simulated auth entries and Soroban transaction data to it. The authorization
// must cover exactly one invocation: one operation, no memo, no fee bump, and
// an invokeContract call to this contract's settlement entry point.
func (c *Client) relayedEnvelope(payload assembledTransactionJSON, settlement SettlementMethod) (xdr.TransactionEnvelope, error) {
	var envelope xdr.TransactionEnvelope
	if err := xdr.SafeUnmarshalBase64(payload.Tx, &envelope); err != nil {
		return xdr.TransactionEnvelope{}, fmt.Errorf("%w: relayed transaction is not a base64 envelope: %v", ErrInvalidArgument, err)
	}
	if envelope.Type != xdr.EnvelopeTypeEnvelopeTypeTx || envelope.V1 == nil {
		return xdr.TransactionEnvelope{}, fmt.Errorf("%w: relayed transaction must be a regular transaction envelope", ErrInvalidArgument)
	}
	tx := &envelope.V1.Tx
	if len(tx.Operations) != 1 {
		return xdr.TransactionEnvelope{}, fmt.Errorf("%w: relayed transaction has %d operations, want exactly 1", ErrInvalidArgument, len(tx.Operations))
	}
	if tx.Memo.Type != xdr.MemoTypeMemoNone {
		return xdr.TransactionEnvelope{}, fmt.Errorf("%w: relayed transaction must not carry a memo", ErrInvalidArgument)
	}
	operation := &tx.Operations[0]
	if operation.Body.Type != xdr.OperationTypeInvokeHostFunction || operation.Body.InvokeHostFunctionOp == nil {
		return xdr.TransactionEnvelope{}, fmt.Errorf("%w: relayed transaction is not an invokeContract call", ErrInvalidArgument)
	}
	invoke := operation.Body.InvokeHostFunctionOp
	if invoke.HostFunction.Type != xdr.HostFunctionTypeHostFunctionTypeInvokeContract || invoke.HostFunction.InvokeContract == nil {
		return xdr.TransactionEnvelope{}, fmt.Errorf("%w: relayed transaction is not an invokeContract call", ErrInvalidArgument)
	}
	args := invoke.HostFunction.InvokeContract
	if string(args.FunctionName) != string(settlement) {
		return xdr.TransactionEnvelope{}, fmt.Errorf(
			"%w: relayed transaction calls %q, not %q", ErrInvalidArgument, args.FunctionName, settlement)
	}
	contractID, err := scAddressString(args.ContractAddress)
	if err != nil {
		return xdr.TransactionEnvelope{}, err
	}
	if contractID != c.contractID {
		return xdr.TransactionEnvelope{}, fmt.Errorf(
			"%w: relayed transaction targets contract %s, not %s", ErrInvalidArgument, contractID, c.contractID)
	}

	entries := make([]xdr.SorobanAuthorizationEntry, 0, len(payload.SimulationResult.Auth))
	for _, raw := range payload.SimulationResult.Auth {
		var entry xdr.SorobanAuthorizationEntry
		if err := xdr.SafeUnmarshalBase64(raw, &entry); err != nil {
			return xdr.TransactionEnvelope{}, fmt.Errorf("%w: decode auth entry: %v", ErrInvalidArgument, err)
		}
		entries = append(entries, entry)
	}
	invoke.Auth = entries

	if payload.SimulationTransactionData == "" {
		return xdr.TransactionEnvelope{}, fmt.Errorf("%w: relayed authorization has no simulation transaction data", ErrInvalidArgument)
	}
	var transactionData xdr.SorobanTransactionData
	if err := xdr.SafeUnmarshalBase64(payload.SimulationTransactionData, &transactionData); err != nil {
		return xdr.TransactionEnvelope{}, fmt.Errorf("%w: decode Soroban transaction data: %v", ErrInvalidArgument, err)
	}
	tx.Ext = xdr.TransactionExt{V: 1, SorobanData: &transactionData}
	return envelope, nil
}
