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
create_escrow(payer, payee, token, amount, condition_ref, releaser, refund_after) -> escrow_id   // IMPLEMENTED + LIVE ON TESTNET (Phase E1 + E2 + E4)
get_status(escrow_id) -> EscrowStatus  // enum: Funded | Released | Refunded — IMPLEMENTED + LIVE ON TESTNET (Phase E1)
get_escrow(escrow_id) -> EscrowData    // read-only: payer, payee, token, amount, condition_ref, status, releaser, refund_after — IMPLEMENTED + LIVE ON TESTNET (Phase E4)
release(escrow_id, caller) -> result   // IMPLEMENTED + LIVE ON TESTNET (Phase E2) — only escrow_id's `releaser` may call this, only while Funded
refund(escrow_id, caller) -> result    // IMPLEMENTED + LIVE ON TESTNET (Phase E2 + E4) — releaser always; anyone too, once refund_after has passed, and then still only back to payer
```
`create_escrow`'s param order in code is `(payer, payee, token, amount, condition_ref, releaser, refund_after)` —
`token` before `amount`, `releaser` added by Phase E2 and `refund_after`
by Phase E4, both last; no behavioral difference beyond the added
params, just noting it so this doc and `src/lib.rs` don't drift.

All five functions are proven live on testnet as of the Phase E4
redeployment (`docs/testnet-deployments.md`, 2026-10-08 entry) — including
a real timeout refund triggered by a non-releaser after its deadline, a
real `release` after the deadline, and real rejections of a
pre-deadline stranger refund (`Error(Contract, #3)`), a deadline already
in the past at creation (`Error(Contract, #5)`), and a second refund on
an already-settled escrow (`Error(Contract, #4)`). The Phase E1 and E2
deployments are superseded (their contract IDs predate the
`refund_after` param and `EscrowData` layout) and are kept only as
historical record.

`refund_after` is an optional unix timestamp in seconds set once at
creation (`docs/adr/0004`): after it passes **anyone** may call
`refund`, but the destination is unchanged — always the stored `payer` —
and `release` is never gated by it, so the releaser can still release
after the deadline (whoever lands first wins). No `refund_after` means
behaviour is exactly what it was before: releaser-only refunds, forever.

## TypeScript SDK surface (`sdk/`)
```ts
import { EscrowClient, Keypair } from "@docforum/escrow-sdk";

const client = new EscrowClient({ contractId }); // defaults: testnet RPC + passphrase
const { escrowId, txHash } = await client.createEscrow({ payer, payee, token, amount, conditionRef, releaser, refundAfter });
await client.getStatus(escrowId);            // "Funded" | "Released" | "Refunded"
await client.getEscrow(escrowId);            // full stored record — incl. releaser + refundAfter, so a payee can check the deal (docs/adr/0004, threat model T8)
await client.release({ escrowId, caller });  // { txHash } — caller: Keypair, must equal the escrow's releaser
await client.refund({ escrowId, caller });   // { txHash } — releaser always; anyone after refundAfter has passed
```
`refundAfter` on `createEscrow` is optional (unix seconds, must be strictly
in the future or the contract rejects with `InvalidRefundAfter`); omit it
for no timeout, which behaves exactly as this contract did before the
param existed.
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
was chosen over a single contract-level admin. The one exception is the
timeout: once `refund_after` has passed, **anyone** may call `refund` for
that escrow, still only back to `payer` — see `docs/adr/0004` for why
that removes a permanent lock without adding a privileged role. The
contract enforces *who* can call release/refund, not *why* — keep it that
way. Baking healthcare-specific logic into the contract is exactly the
scope creep this repo exists to avoid (see README "why this repo exists,
honestly").

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
