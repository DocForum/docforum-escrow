# Passkey Smart Wallet Payer Example

This example demonstrates how to fund an escrow from a
passkey-backed Sorban smart wallet (a contract account) using the SDK's
smart-wallet payer flow.

The example runs on Stellar testnet only. It uses a software
secp256r1 key to simulate the WebAuthn passkey that a browser would
produce, so the entire flow can be exercised headlessly in CI.

## Why contract-account auth is different

For a classic Stellar account payer, the SDK builds a transaction
envelope and the signer signs the envelope hash. For a contract
payer (smart wallet), there is no envelope signer. Instead:

1. The SDK builds the invocation for `fund_escrow and attaches a
   `SorbanAuthorizationEntry` for the contract payer.
2. The SDK returns the auth entry (and its pre-image) to the caller
   instead of signing the envelope.
3. The passkey wallet signs the auth entry pre-image with its
   secp256r1 key (WebAuthn assertion) and returns the signature.
4. The SDK attaches the signature to the auth entry, sets a
   sensible expiration ledger, and submits the transaction.

The balance-delta check in the escrow contract works the same way
regardless of whether the payer is an account or a contract; this
example asserts that explicitly.

## Prerequisites

- Node.js 20 or newer.
- A funded testnet account used to deploy the smart wallet and to
  pay fees. This account is not the payer; it only submits the
  transaction.
- The escrow contract WASM built from this repo.

Set the following environment variables:

```bash
STELLAR_NETWORK=testnet
SOURCE_SECRET=S<your testnet secret key>
ESCROW_ID=<escrow id to fund>
ESCROW_CONTRACT_ID=<deployed escrow contract address>
```

## Running the example

```bash
cd examples/passkey-smart-wallet
npm install
npm run start
```

The script performs these steps:

1. Generates a software secp256r1 key pair that stands in for the
   passkey credential.
2. Deploys the reference smart wallet contract with the secp256r1
   public key as its signer.
3. Funds the smart wallet contract address with the asset used
   by the escrow.
4. Calls the SDK's `prepareEscrowFundingAuthEntry` to build the
   auth entry for the contract payer.
5. Signs the auth entry pre-image with the software secp256r1
   key and attaches the signature via `signEscrowFundingAuthEntry`.
6. Submits the transaction and verifies that the escrow balance
   delta matches the funded amount.

## Auth flow in detail

```ts
import {
  prepareEscrowFundingAuthEntry,
  signEscrowFundingAuthEntry,
  submitEscrowFunding,
} from "@stellar-escrow-sdk";

// 1. Build the auth entry for the contract payer.
const prepared = await prepareEscrowFundingAuthEntry({
  networkPassphrase: Networks.TESTNET.passphrase,
  sourceAccount: sourceKeypair.publicKey(),
  escrowContractId,
  escrowId,
  payer: smartWalletAddress, // C... contract address
  asset: Asset.native(),
  amount: "10000000",
  // Auth entries expire after a bounded number of ledgers.
  // 100 ledgers ~(5 minutes) is enough for a passkey prompt
  // without leaving a long-lived signature around.
  signatureExpirationLedges: 100,
});

// 2. Sign the auth entry pre-image with the passkey (secp256r1) key.
//    The wallet returns the 64-byte r||s signature and the key identifier.
const signed = await signEscrowFundingAuthEntry({
  prepared,
  signer: {
    type: "secp256r1",
    keyId: passkeyKeyId,
    sign: (challenge) => passkeySign(challenge),
  },
});

// 3. Submit the transaction with the signed auth entry attached.
const result = await submitEscrowFunding({
  sourceKeypair,
  prepared,
  signed,
  networkPassphrase: Networks.TESTNET.passphrase,
});
```

The key differences from an account payer are:

- **Signed object:** the auth entry pre-image, not the transaction
  envelope hash.
-- **Signer type:** `secp256r1` instead of an ed25519 Stellar key.
- **Expiration:** auth entries carry a signature expiration ledger
  that must be set relative to the current ledge.
- **Fee source:** the transaction is still submitted by a regular
  account that pays fees and provides the sequence number.

## Signature expiration

Auth entry signatures expire at a ledger number. The SDK defaults
to a short window (100 ledgers, roughly five minutes) and caps the
requested window at the network's maximum auth entry lifetime. Set
`signatureExpirationLedgers` explicitly when a WebAuthn prompt
may take longer than the default.

## Balance-delta check with a contract payer

The escrow contract records the asset balance before and after the
transfer and rejects funding if the delta does not match the
requested amount. This check is identical for account and contract
payers. The example asserts the resulting escrow balance after
funding to confirm the check passed with a contract payer.

## Testing

```bash
cd examples/passkey-smart-wallet
npm run test
```

The test suite runs the full flow against a test smart wallet
contract with a software secp256r1 key and verifies that the escrow
is funded with the expected amount.

## Notes

- Testnet only. Do not use this example with mainnet keys.
- The software secp256r1 key is generated at runtime and is not
  persisted.
- The smart wallet contract used here is the reference
  implementation in `contracts/smart-wallet-`.
