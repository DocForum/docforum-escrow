# Contract-account payers (passkey / smart wallets)

This document describes what changes when an escrow is funded by a Soroban
**contract account** — for example a passkey-backed smart wallet — instead of a
classic Stellar account, and what the SDK supports today.

## Background

A classic Stellar account (`G...`) authorizes a Soroban invocation by signing
the transaction envelope. A contract account (`C...`) has no secret key of its
own, so it cannot sign an envelope at all. Instead, the contract's `__check_auth`
function validates a **Soroban authorization entry** attached to the invocation.
The entry carries the contract address as the signer plus an opaque signature
payload that only that contract understands.

For a passkey wallet the payload is a secp256r1 (WebAuthn) assertion over the
entry's signature payload. The wallet, not the SDK, owns the private key: the
SDK builds the invocation and its auth entry, the wallet signs the entry, and
the signed entry is attached before submission.

## The escrow contract needs no change

`payer` is an `Address`, and a contract address is a valid `Address`. The
contract pulls the token from `payer` with `payer`'s authorization, so the
balance-delta check is identical for account and contract payers. Everything
that differs lives on the client side.

## The auth-entry flow

1. Build the invocation for `create_escrow(payer, ...)` and simulate it.
2. Collect the auth entries the simulation returns. The entry for `payer` has
   `sorobanCredentialsAddress` whose address is the wallet contract, and carries
   a `signatureExpirationLedger`.
3. Hand the entry's signature payload to the wallet. A passkey wallet signs it
   with its secp256r1 key and returns the assertion; the wallet's `__check_auth`
   verifies it against the credential it stores.
4. Replace the entry's signature with the signed one, re-assemble and submit.

`signatureExpirationLedger` must be in the future at submission time. A
conservative default is the current ledger plus a small margin; callers that
batch many signatures should set it explicitly. The ledger sequence is available
from `getLatestLedger()` on the Soroban RPC server.

## What the SDK supports today

The SDK's write path (`createEscrow`, `release`, `refund`, …) signs the
transaction envelope with the configured `EscrowSigner`. That covers `G...`
payers, and it is the recommended path for them.

It does **not** yet build and return auth entries for `C...` payers: a contract
address cannot be the signer for the envelope, so `createEscrow` with a
contract-account `payer` fails at signing. Supporting it needs a two-step API —
prepare (build the invocation and return the assembled transaction plus its auth
entries), then submit (attach the wallet-signed entries) — and a test wallet
contract to exercise `__check_auth` on testnet. Neither the API nor such a
contract exists in this repository yet; treat that as the follow-up work.

Until then, integrators with a passkey wallet can still use the contract
directly: the wallet builds the `create_escrow` invocation, signs the auth entry
with its own mechanism, submits it, and uses the SDK read path (`getEscrow`,
`getStatus`) afterwards, which needs no signer.

## Testing expectations for the follow-up

- A committed smart-wallet fixture contract with a passkey verifier, deployed to
  testnet, and its address recorded in `docs/testnet-deployments.md`.
- An offline test for the prepare step that asserts the auth entry's address is
  the wallet contract and that `signatureExpirationLedger` is in the future.
- An integration test (gated like the rest of `testnet-integration.test.ts`)
  that funds an escrow from the wallet and asserts the escrow status and the
  wallet's token balance delta.
