# ARCHITECTURE_ESSENTIALS.md -- docforum-escrow

## Stack
- **Contract**: Rust, Soroban SDK, targeting Stellar testnet first, mainnet
  only after a real security review (not yet scheduled — see ROADMAP.md).
- **SDK**: TypeScript, wraps `@stellar/stellar-sdk` + generated contract
  bindings, published as `@docforum/escrow-sdk` on npm.
- No database. No server. This repo ships a contract + a client library —
  nothing here runs as a persistent service.

## Contract surface
```
__constructor(allowed_tokens: Vec<Address>)    // immutable token allowlist; empty means allow all
create_escrow(payer, payee, token, amount, condition_ref, releaser, refund_after, notify_payee, refund_to) -> escrow_id   // Phase E5 callback + `refund_to` (ADR 0009) implemented locally; not deployed
create_escrow_with_acceptance(..., requires_acceptance, refund_to) -> escrow_id   // optional payee acceptance gate
accept(escrow_id, payee) -> ()   // payee-authorized, one-time acceptance before release
create_escrow_with_releasers(payer, payee, token, amount, condition_ref, releasers, threshold, refund_after, notify_payee, refund_to) -> escrow_id // IMPLEMENTED (Phase E5, issue #119, ADR 0007) — M-of-N, 1..=10 releasers, 1 <= threshold <= len
get_status(escrow_id) -> EscrowStatus  // enum: Funded | Released | Refunded — IMPLEMENTED + LIVE ON TESTNET (Phase E1)
get_escrow(escrow_id) -> EscrowData    // read-only: payer, payee, token, amount, condition_ref, status, releasers, threshold, refund_after, refund_to — IMPLEMENTED (Phase E4 + E5; `releaser` became `releasers`+`threshold` in #119)
release(escrow_id, caller) -> result   // IMPLEMENTED (Phase E2) — a releaser, threshold must be 1, only while Funded
release_with_approvals(escrow_id, approvers) -> result   // IMPLEMENTED (Phase E5, issue #119, ADR 0007) — >= threshold distinct releasers, each authorizing this invocation
refund(escrow_id, caller) -> result    // IMPLEMENTED (Phase E2 + E4) — a releaser when threshold is 1; anyone too, once refund_after has passed, and then still only to the stored `refund_to` (= payer unless set at creation, ADR 0009)
refund_with_approvals(escrow_id, approvers) -> result    // IMPLEMENTED (Phase E5, issue #119) — same approval rules as release_with_approvals
top_up(escrow_id, payer, amount) -> result // IMPLEMENTED (issue #26) — original payer only, funded state only; emits `top_up`
solvency(token) -> (balance, liabilities)  // read-only: contract's on-chain token balance vs total outstanding liability — IMPLEMENTED (Phase E5)
```

No new contract-level role came in with the M-of-N work: `releasers` is
escrow data chosen by the payer at creation and immutable afterwards. There is
still no admin, no owner, no pause and no upgrade path — OpenZeppelin's
pausable/upgradeable/access modules were evaluated and rejected in
`docs/adr/0006` precisely because they would add one.
The allowlist is fixed when the contract is deployed. `create_escrow`
rejects any token outside a non-empty list with `DisallowedToken` (error
code 8); an empty list preserves the prior open-token behavior. The
current live deployment predates this constructor and must be redeployed
before the allowlist protection is active.

`create_escrow`'s param order in code is `(payer, payee, token, amount, condition_ref, releaser, refund_after, notify_payee, refund_to)`.
`notify_payee` opts a contract payee into `on_escrow_released(escrow_id,
amount)`; when true, the payee must authorize creation as well as the payer.
The quorum creation entry point has the same final callback flag. The SDK
option defaults to false. Callback failure rolls release back atomically;
see ADR 0005 for failure, gas, and stored-record compatibility.

The Phase E4-era functions (`create_escrow`, `get_status`, `get_escrow`,
`release`, `refund`) are proven live on testnet as of the Phase E4
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

feat/issue-39-phase-e5-per-token-liability-accounting-and-an
## Per-token liability accounting (Phase E5)
The contract maintains `liabilities[token]`, the total amount of
that token currently owed to escrow payees (and to payers via the
refund path). It is incremented in the same invocation as every
state-changing function that adds funds (`create_escrow`, and any
future top-up) and decremented in the same invocation as every
function that releases funds (`release`, `refund`). Because the update
happens in the same invocation as the escrow state transition, the
counter can never drift from the sum of outstanding escrows.

`solvency(token) -> (balance, liabilities)` is a read-only view that
returns the contract's current on-chain balance of `token` alongside
the recorded liability, so a monitor or auditor can answer "does the
contract hold at least as much of token X as it owes?" in a single
call. `balance >= liabilities` is the solvency condition; `a balance
below liabilities is the observable signal of the shared-pool risk
described in the threat model (T9).

The liability entry is stored in contract storage with explicit
TTL extension management consistent with the escrow entries (#10):
every write that mutates `liabilities[token]` extends the entry's
TTL so an active liability entry is never archived while it is nondero.

`refund_to` (Phase E5, `docs/adr/0006`) is an optional address, set at
creation under the funder's (`payer`'s) auth, that every refund path pays
instead of `payer`. It is stored, immutable, never supplied at payout, and
may not be the contract itself (`InvalidRefundTo`); omitted, it equals
`payer` and behaviour is exactly as before. Invariant I1 is therefore
"release → stored `payee`, refund → stored `refund_to`".
main

## TypeScript SDK surface (`sdk/`)
```ts
import { EscrowClient, Keypair } from "@docforum/escrow-sdk";

const client = new EscrowClient({ contractId }); // defaults: testnet RPC + passphrase
const { escrowId, txHash } = await client.createEscrow({ payer, payee, token, amount, conditionRef, releaser, refundAfter, notifyPayee: true, refundTo });
await client.createQuorumEscrow({ payer, payee, token, amount, conditionRef, releasers, threshold, refundAfter, notifyPayee: true }); // M-of-N, ADR 0007
await client.getStatus(escrowId);            // "Funded" | "Released" | "Refunded"
await client.getEscrow(escrowId);            // full stored record — incl. releasers + threshold + refundAfter, so a payee can check the deal (docs/adr/0004/0007, threat model T8)
await client.release({ escrowId, caller });  // { txHash } — caller: Keypair, must be a releaser and threshold must be 1
await client.releaseWithApprovals({ escrowId, approvers }); // { txHash } — one Keypair per approver (>= threshold, distinct)
await client.refund({ escrowId, caller });   // { txHash } — releaser when threshold is 1; anyone after refundAfter has passed
await client.refundWithApprovals({ escrowId, approvers });  // { txHash } — M-of-N refund
await client.solvency(token);            // { balance, liabilities } — read-only solvency view (Phase E5)
await client.getEvents({ fromLedger });      // { events, nextCursor } — decoded lifecycle event page
const stop = client.subscribe(handler, { cursor, pollIntervalMs }); // serial polling; await handler for back-pressure
await client.estimate({ source, method, args }); // { resourceFee, inclusionFee, total, minResourceFee } — simulation only, 20% resource buffer
client.guardSponsorship(signedXdr);          // { ok, reasons, invokedContracts } — every op + contract auth entry must target this escrow
client.feeBump(signedXdr, sponsor, { maxFee, baseFee? }); // { xdr, fee, innerTxHash } — throws MaxFeeExceededError, never overshoots the cap
```
`refundTo` on `createEscrow` is optional too (default: the payer) and
`getEscrow` returns it as `refundTo`.

`estimate` never signs or submits; it simulates against the client's RPC
and reports stroops. `guardSponsorship` is the pre-sponsorship check for
transactions that come from someone else: it rejects foreign contract
invocations, non-invocation operations, contract-address auth entries
pointing elsewhere, and already-bumped envelopes, while allowing the
account auth entries (payer/releaser) a legitimate escrow call carries.
`feeBump` charges `baseFee × (inner operations + 1)` and validates the
cap before building the envelope, so a fee spike fails loudly instead of
silently costing more than the sponsor agreed to.
Event results are a discriminated union: known lifecycle events expose
their event type and escrow id; unrecognized topics are returned as
`type: "unknown"` with decoded topic values and payload. Persist the
last handled event's cursor to resume; an expired RPC history cursor throws
`EventCursorExpiredError`. These helpers require the contract lifecycle
events tracked by issue #9; the current deployment does not emit them.
`refundAfter` on `createEscrow` is optional (unix seconds, must be strictly
in the future or the contract rejects with `InvalidRefundAfter`); omit it
for no timeout, which behaves exactly as this contract did before the
param existed.
`solvency` is a read-only view with no side effects and no authorization
requirement — anyone can call it to check whether the contract holds
at least as much of a token as it owes.
`MAX_RELEASERS` (10) and `MAX_CONDITION_REF_LENGTH` (64) mirror the contract's
bounds client-side so callers fail fast. `getEscrow()` returns
`releasers: string[]` and `threshold: number` (`releaser: string` was replaced
in SDK 0.5.0 when the contract's `EscrowData` changed).
`sdk/src/generated/contract-client.ts` is machine-generated
(`stellar contract bindings typescript --wasm ...`) — never hand-edit it;
regenerate it whenever the contract's public signatures/types change. CI now
enforces that: `.github/workflows/ci.yml`'s `sdk-bindings` job rebuilds the
WASM, regenerates with the CLI version pinned in `scripts/stellar-cli-version`,
and diffs the result (`scripts/check-generated-bindings.sh`, issue #121). See
`sdk/src/generated/README.md` for the regeneration steps.
`sdk/src/index.ts` is the actual public surface (hand-written, ergonomic
wrapper) — consumers import from the package root, never from
`src/generated/` directly.`condition_ref` is an **opaque string/id** the contract does not interpret, bounded to 64 bytes at creation (error `ConditionRefTooLong = 7`; SDK constant `MAX_CONDITION_REF_LENGTH`) — it's the caller's job (e.g. `docforum-core`) to decide when release is warranted and call `release()`. `releaser` is the one address permitted
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