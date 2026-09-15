# ARCHITECTURE_ESSENTIALS.md — docforum-escrow

## Stack
- **Contract**: Rust, Soroban SDK, targeting Stellar testnet first, mainnet
  only after a real security review (not yet scheduled — see ROADMAP.md).
- **SDK**: TypeScript, wraps `@stellar/stellar-sdk` + generated contract
  bindings, published as `@docforum/escrow-sdk` on npm.
- No database. No server. This repo ships a contract + a client library —
  nothing here runs as a persistent service.

## Contract surface
```
create_escrow(payer, payee, token, amount, condition_ref, releaser) -> escrow_id   // IMPLEMENTED + LIVE ON TESTNET (Phase E1 + E2)
get_status(escrow_id) -> EscrowStatus  // enum: Funded | Released | Refunded — IMPLEMENTED + LIVE ON TESTNET (Phase E1)
release(escrow_id, caller) -> result   // IMPLEMENTED + LIVE ON TESTNET (Phase E2) — only escrow_id's `releaser` may call this, only while Funded
refund(escrow_id, caller) -> result    // IMPLEMENTED + LIVE ON TESTNET (Phase E2) — same rule as release, transfers back to payer
```
`create_escrow`'s param order in code is `(payer, payee, token, amount, condition_ref, releaser)` —
`token` before `amount`, and `releaser` added last — differs slightly from
the original sketch above; no behavioral difference beyond the added
param, just noting it so this doc and `src/lib.rs` don't drift.

All four functions are proven live on testnet as of the Phase E2
redeployment (`docs/testnet-deployments.md`, 2026-09-15 entry) — including
a real `release`, a real `refund`, and a real unauthorized-caller
rejection, not just the local test suite. The prior Phase E1-only
deployment is superseded (its contract ID predates the `releaser` param
and is kept only as historical record).

## TypeScript SDK surface (`sdk/`)
```ts
import { EscrowClient, Keypair } from "@docforum/escrow-sdk";

const client = new EscrowClient({ contractId }); // defaults: testnet RPC + passphrase
const escrowId = await client.createEscrow({ payer, payee, token, amount, conditionRef, releaser });
await client.getStatus(escrowId);           // "Funded" | "Released" | "Refunded"
await client.release({ escrowId, caller });  // caller: Keypair, must equal the escrow's releaser
await client.refund({ escrowId, caller });
```
`sdk/src/generated/contract-client.ts` is machine-generated
(`stellar contract bindings typescript --wasm ...`) — never hand-edit it;
regenerate it whenever the contract's public signatures/types change.
`sdk/src/index.ts` is the actual public surface (hand-written, ergonomic
wrapper) — consumers import from the package root, never from
`src/generated/` directly.

`condition_ref` is an **opaque string/id** the contract does not interpret
— it's the caller's job (e.g. `docforum-core`) to decide when release is
warranted and call `release()`. `releaser` is the one address permitted
to call `release`/`refund` for that specific escrow, set once at
`create_escrow` time — see `docs/adr/0002` for why a per-escrow releaser
was chosen over a single contract-level admin. The contract enforces
*who* can call release/refund, not *why* — keep it that way. Baking
healthcare-specific logic into the contract is exactly the scope creep
this repo exists to avoid (see README "why this repo exists, honestly").

## Hard rules
1. **No PHI, ever, anywhere in this repo.** Not in tests, not in example
   fixtures, not in comments. This repo should be safely public and
   understandable with zero healthcare context.
2. Contract logic changes require updated tests in
   `contracts/escrow/tests/` before merge — payment logic bugs are not
   "fix in a follow-up" territory.
3. SDK version bumps that change the public API are breaking changes —
   semver strictly, since `docforum-core` pins a version rather than
   tracking latest.
4. Testnet only until a security review has happened. Do not wire mainnet
   contract addresses into the SDK's defaults.

## Roadmap / status
See `ROADMAP.md` in this repo. Live testnet deployment record:
`docs/testnet-deployments.md`.
