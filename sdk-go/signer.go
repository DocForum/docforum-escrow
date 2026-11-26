package escrow

import (
	"context"
	"crypto/sha256"
	"fmt"

	"github.com/stellar/go-stellar-sdk/keypair"
	"github.com/stellar/go-stellar-sdk/network"
	"github.com/stellar/go-stellar-sdk/strkey"
	"github.com/stellar/go-stellar-sdk/xdr"
)

// Signer is the minimal surface the client needs to authorize a transaction.
// SignTransaction receives a base64 TransactionEnvelope XDR and must return a
// signed base64 TransactionEnvelope XDR. KeypairSigner is the built-in
// implementation; external wallets can implement this interface later.
type Signer interface {
	Address() string
	SignTransaction(ctx context.Context, envelopeXDR string) (string, error)
}

// KeypairSigner signs with a local Stellar secret key. It is intended for
// testnet/local development, not for custodying mainnet keys.
type KeypairSigner struct {
	keypair           *keypair.Full
	networkPassphrase string
}

// NewKeypairSigner parses an S... secret key. An empty networkPassphrase
// defaults to the Stellar testnet passphrase.
func NewKeypairSigner(secret, networkPassphrase string) (*KeypairSigner, error) {
	kp, err := keypair.ParseFull(secret)
	if err != nil {
		return nil, fmt.Errorf("%w: parse secret key: %v", ErrInvalidArgument, err)
	}
	if networkPassphrase == "" {
		networkPassphrase = network.TestNetworkPassphrase
	}
	return &KeypairSigner{keypair: kp, networkPassphrase: networkPassphrase}, nil
}

// NewKeypairSignerFromKeypair wraps an existing keypair. An empty
// networkPassphrase defaults to the Stellar testnet passphrase.
func NewKeypairSignerFromKeypair(kp *keypair.Full, networkPassphrase string) *KeypairSigner {
	if networkPassphrase == "" {
		networkPassphrase = network.TestNetworkPassphrase
	}
	return &KeypairSigner{keypair: kp, networkPassphrase: networkPassphrase}
}

// Address returns the G... public address of the signer.
func (s *KeypairSigner) Address() string {
	return s.keypair.Address()
}

// Keypair returns the underlying keypair. It is only needed for advanced
// integration tests; most callers should use the Signer interface.
func (s *KeypairSigner) Keypair() *keypair.Full {
	return s.keypair
}

// SignTransaction adds this keypair's signature to the supplied envelope.
func (s *KeypairSigner) SignTransaction(ctx context.Context, envelopeXDR string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	var envelope xdr.TransactionEnvelope
	if err := xdr.SafeUnmarshalBase64(envelopeXDR, &envelope); err != nil {
		return "", fmt.Errorf("%w: decode transaction envelope: %v", ErrWalletRejected, err)
	}

	hash, err := network.HashTransactionInEnvelope(envelope, s.networkPassphrase)
	if err != nil {
		return "", fmt.Errorf("%w: hash transaction: %v", ErrWalletRejected, err)
	}
	signature, err := s.keypair.Sign(hash[:])
	if err != nil {
		return "", fmt.Errorf("%w: sign transaction: %v", ErrWalletRejected, err)
	}

	hint := s.keypair.Hint()
	decorated := xdr.DecoratedSignature{
		Hint:      xdr.SignatureHint(hint),
		Signature: xdr.Signature(signature),
	}

	switch envelope.Type {
	case xdr.EnvelopeTypeEnvelopeTypeTx:
		envelope.V1.Signatures = append(envelope.V1.Signatures, decorated)
	case xdr.EnvelopeTypeEnvelopeTypeTxV0:
		envelope.V0.Signatures = append(envelope.V0.Signatures, decorated)
	case xdr.EnvelopeTypeEnvelopeTypeTxFeeBump:
		envelope.FeeBump.Signatures = append(envelope.FeeBump.Signatures, decorated)
	default:
		return "", fmt.Errorf("%w: unsupported transaction envelope type %s", ErrWalletRejected, envelope.Type)
	}

	signed, err := xdr.MarshalBase64(envelope)
	if err != nil {
		return "", fmt.Errorf("%w: encode signed transaction envelope: %v", ErrWalletRejected, err)
	}
	return signed, nil
}

// signSorobanAuthEntry signs an address-credential authorization entry using
// the CAP-46 preimage. Only KeypairSigner can do this; single-signer calls
// avoid it by rewriting the signer's own entries to source-account credentials.
func signSorobanAuthEntry(entry *xdr.SorobanAuthorizationEntry, kp *keypair.Full, networkPassphrase string, expirationLedger uint32) error {
	if entry.Credentials.Type != xdr.SorobanCredentialsTypeSorobanCredentialsAddress {
		return fmt.Errorf("%w: auth entry uses %s credentials", ErrUnsupportedAuthorization, entry.Credentials.Type)
	}
	if entry.Credentials.Address == nil {
		return fmt.Errorf("%w: address credentials missing", ErrUnsupportedAuthorization)
	}

	credentials := entry.Credentials.Address
	credentials.SignatureExpirationLedger = xdr.Uint32(expirationLedger)

	networkID := network.ID(networkPassphrase)
	preimage := xdr.HashIdPreimage{
		Type: xdr.EnvelopeTypeEnvelopeTypeSorobanAuthorization,
		SorobanAuthorization: &xdr.HashIdPreimageSorobanAuthorization{
			NetworkId:                 xdr.Hash(networkID),
			Nonce:                     credentials.Nonce,
			SignatureExpirationLedger: xdr.Uint32(expirationLedger),
			Invocation:                entry.RootInvocation,
		},
	}
	payload, err := preimage.MarshalBinary()
	if err != nil {
		return fmt.Errorf("escrow: encode soroban auth preimage: %w", err)
	}
	digest := sha256.Sum256(payload)
	signature, err := kp.Sign(digest[:])
	if err != nil {
		return fmt.Errorf("%w: sign auth entry: %v", ErrWalletRejected, err)
	}
	publicKey, err := strkey.Decode(strkey.VersionByteAccountID, kp.Address())
	if err != nil {
		return fmt.Errorf("escrow: decode signer public key: %w", err)
	}

	signatureMap := scvMap([]xdr.ScMapEntry{
		{Key: scvSymbol("public_key"), Val: scvBytes(publicKey)},
		{Key: scvSymbol("signature"), Val: scvBytes(signature)},
	})
	signatureScVal := scvVec([]xdr.ScVal{signatureMap})
	credentials.Signature = signatureScVal
	return nil
}

func sourceAccountCredentials() xdr.SorobanCredentials {
	return xdr.SorobanCredentials{
		Type: xdr.SorobanCredentialsTypeSorobanCredentialsSourceAccount,
	}
}
