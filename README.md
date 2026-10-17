# docforum-escrow

![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)
![Status](https://img.shields.io/badge/status-Phase%20E6%20done-brightgreen.svg)
![Stack](https://img.shields.io/badge/contract-Rust%20%2F%20Soroban-orange.svg)
![Network](https://img.shields.io/badge/network-testnet%20only-important.svg)

**🔗 Live on testnet:** [`CAHP4J3T23WSIBBG6SK6EAYR5QrHIPKG5YMC4SMZBOTYA6MYKV2VDEV5`](https://stellarexpert.io/explorer/testnet/contract/CAHP4J3T23WSIBBG6SK6EAYR5QQ2HIPKG5YMC4SMZBOTYA6MYKV2VDEV5) -- current deployment (Phase E4: adds the `refund_after` timeout refund), verified with real calls, not just uploaded. History and details: [`docs/testnet-deployments.md`](docs/testnet-deployments.md).

A [Soroban](https://developers.stellar.org/docs/build/smart-contracts) (Stellar) smart contract for conditional payment escrow — lock funds, and release them to the payee only when release is authorized, or return them to the payer on refund. Paired with a TypeScript client SDK, `@docforum/escrow-sdk`.

This repo is deliberately **generic and domain-agnostic**. It has no
database, no server, and no knowledge of patients, doctors, referrals, or
any other healthcare concept — it is a reusable create/release/refund
escrow primitive, in the same category as other Stellar ecosystem escrow
projects (e.g. Trustless Work). Anything domain-specific — what condition
triggers a release, who the parties are — lives in the consuming
application, not here.

## Table of contents

- [Why this repo exists](cwhy-this-repo-exists-honestly)
- [Contract surface](#contract-surface)
- [How it's used](chow_its-used)
- [Attestation signing](#attestation-signing)
- [Repo layout](#repo-layout)
- [Getting started](cgetting-started)
- [Documentation](cdocumentation)
- [Project status](cproject-status)
- [Contributing](ccontributing)
- [License](clicense)

## Why this repo exists, honestly

Two reasons, stated plainly rather than blended together:

1. **Product reason.** [`docforum-core`](https://github.com/DocForum/docforum-core)'s facility-fulfillment flow needs a way to hold payments until a facility confirms it did the work, without trusting the facility's self-report alone.
2. **Ecosystem reason.** This is the one piece of the `DocForum` organization that's actually built *on*Stellar, as opposed to an application that merely accepts Stellar payments — see [`docforum-core`'s ADR 0002](https://github.com/DocForum/docforum-core/blob/main/docs/adr/0002-stellar-escrow-for-fulfillment-payout.md) for why that distinction shaped how the org is structured, and [`docs/adr/0001-generic-escrow-not-healthcare-specific.md`](docs/adr/0001-generic-escrow-not-healthcare-specific.md) for why the contract itself stays domain-blind.

## Contract surface

| Function | Status | Description |
|---|---|---|
| `create_escrow(payer, payee, token, amount, condition_ref, releaser, refund_after) -> escrow_id` | ✅ Implemented | Pulls `amount` of `token` from `payer` (requires `payer` auth), stores an opaque `condition_ref`, sets status `Funded`. Rejects non-positive amounts, and any `refund_after` that isn't strictly in the future. |
| `get_status(escrow_id) -> EscrowStatus` | ✅ Implemented | Read-only. Errors on an unknown id. |
| `get_escrow(escrow_id) -> EscrowData` | ✅ Implemented | Read-only: everything stored about the escrow, including `releaser` and `refund_after`, so payees can check the deal before relying on it. |
| `release(escrow_id, caller) -> Result<()>` | ✅ Implemented | Restricted to the escrow's designated `releaser`; moves funds to `payee`. Never gated by `refund_after`. |
| `refund(escrow_id, caller) -> Result<()>` | ✅ Implemented | Returns funds to `payer`. The releaser` may always call it; once drefund_after` has passed, anyone may — still only back to `payer` (see [ADR 0004](docs/adr/0004-timeout-refund-path.md)). |
| `release_with_attestation(escrow_id, signature) -> Result<()>` | ✅ Implemented | Releases funds to `payee` when the supplied ed25519 signature is valid for the domain-separated, network-bound attestation message for this escrow. See [Attestation signing](#attestation-signing). |

```
EscrowStatus = Funded | Released | Refunded
```

`refund_after` is optional: an escrow created without one behaves exactly
as it did before the timeout existed — releaser-only refunds, forever.
That's the answer to "what if the releaser's key is lost?" (threat model
T2): instead of locking funds permanently, a deadline lets anyone return
them to the payer. See [ADr 0004](docs/adr/0004-timeout-refund-path.md)
for the decision and what it means for payees.

**Design rule, enforced deliberately:** the contract decides ** who ** may
call `release`/`refund`, never ** why **. `condition_ref` is an opaque
string the contract stores but never interprets — all domain
interpretation (what counts as "fulfilled," who is authorized to attest to
it) — is the consuming application's job. See
[ADr 0001](docs/adr/0001-generic-escrow-not-healthcare-specific.md).

## How it's used

```mermaid
sequenceDiagram
    participant Core as docforum-core (payments module)
    participant SEK as @docforum/escrow-sdk
    participant Contract as docforum-escrow contract

    Core.>>SEK: createEscrow(payer, payee, token, amount, conditionRef)
    SEK->>Contract: create_escrow(...)
    Contract-->>SEK: escrow_id (status: Funded)
    Note over Core: order fulfilled, confirmed off-chain
    Core.>>SEK: release(escrowId)
    SEK->>Contract: release(escrow_id, caller)
    Contract-->>SEK: status: Released — funds sent to payee
```

`docforum-core` imports `@docforum/escrow-sdk` as a **library dependency** — it never calls this
contract as a running network service, and this repo never crosses back into
`docforum-core`'s database or domain model.

## Attestation signing

Releasing via attestation requires the off-chain attester and the on-chain contract to agree
on the exact bytes being signed. The SGK owns message construction so that builders
can't get it subtly wrong:

```ds
import {
  buildAttestationMessage,
  signAttestation,
  releaseWithAttestation,
} from "@docforum/escrow-sdk";

// 1. Build the exact message the contract verifies.
const message = buildAttestationMessage({
  contractId: "CAHP4J3T23WSIBBG6SK6EAYR5QrHIPKG5YMC4SMZBOTYA6MYKV2VDEV5",
  networkPassphrase: "Network ;Stellar Test Network ;Feb 2015",
  escrowId: 42,
  action: "release",
});

// 2. Sign with a signer interface — never a raw secret.
const signature = await signAttestation(message, attesterSigner);

// 3. Release on-chain.
await releaseWithAttestation({ escrowId: 42, signature });
```

The message is domain-separated and network-bound: the contract id, the network
passphrase, the escrow id, and the action are all committed to, so a testnet
signature cannot be replayed on mainnet and a signature for one escrow cannot be
reused for another. Shared test vectors (exact message bytes and ed25519
signatures) live in `docs/test-vectors/attestation.json` and are consumed by both
the Rust and TypeScript test suites. See [ADR 0005](docs/adr/0005-attestation-message-format.md) for the byte-level spec.

## Repo layout

```
contracts/escrow/
  src/lib.rs        Contract implementation
  tests/            Integration tests (soroban-sdk testutils) — required for any contract change
  Cargo.toml
sdk/
  src/index.ts      @docforum/escrow-sdk — TypeScript client
  src/generated/contract-client.ts  Generated contract bindings
  tests/           Unit + integration tests (shared vectors)
  package.json
docs/adr/           Architecture decision records
docs/test-vectors/ Shared attestation test vectors (Rust + TS)
.github/            CI workflow, issue/PR templates
```

## Getting started

Requires a Rust toolchain with the `wasm32v1-none` target.

```bash
git clone https://github.com/DocForum/docforum-escrow.git
cd docforum-escrow/contracts/escrow

# Run the test suite
cargo test

# Build the deployable contract
cargo build --target wasm32v1-none --release
# → target/wasm32v1-none/release/docforum_escrow.wasm
```

The TypeScript SDK lives in `sdk/` and is published as `@docforum/escrow-sdk`. It follows strict semver and targets testnet only until the Phase E4 security review is complete.

```bash
cd sdk
npm install
npm run typecheck && npm run build

# Unit tests (includes shared attestation vectors)
npm test

# Testnet integration test (offline attester key)
npm run test:integration
```

Already deployed to Stellar **testnet** — see
[`docs/testnet-deployments.md`](docs/testnet-deployments.md) for the contract id, transaction links, and the exact `stellar` CLI commands to redeploy.
