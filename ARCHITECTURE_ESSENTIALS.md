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
__constructor(allowed_tokens: Vec<Address>)    // immutable token allowlist; empty means allow all
version() -> String    // semantic contract version; source revision and Soroban SDK version are embedded as WASM metadata
create_escrow(payer, payee, token, amount, condition_ref, releaser, refund_after, notify_payee, refund_to, fee_recipient, fee_bps) -> escrow_id   // Phase E5 callback + sponsored refund destination (ADR 0009) + optional protocol fee (ADR 0010); the fee is not yet on testnet
create_escrow_release_time(..., fee_recipient, fee_bps) -> escrow_id   // single-releaser creation with an earliest release time; accepts the same optional fee pair
create_escrow_with_acceptance(..., requires_acceptance, refund_to) -> escrow_id   // optional payee acceptance gate; deployed on testnet
accept(escrow_id, payee) -> ()   // payee-authorized, one-time acceptance before release; deployed on testnet
cancel(escrow_id, payer) -> ()   // payer-authorized, only while Funded + requires_acceptance + not yet accepted; funds to refund_to, status Cancelled (ADR 0010); not deployed yet
create_escrow_with_releasers(payer, payee, token, amount, condition_ref, releasers, threshold, refund_after, notify_payee, refund_to) -> escrow_id // IMPLEMENTED (Phase E5, issue #119, ADR 0007) — M-of-N, deployed on testnet
get_status(escrow_id) -> EscrowStatus  // enum: Funded | Released | Refunded | Cancelled — IMPLEMENTED + LIVE ON TESTNET (Phase E1); also answers for settled ids from the `Status` entry that outlives the record (ADR 0013)
get_escrow(escrow_id) -> EscrowData    // read-only, Funded escrows only (NotFound once settled, ADR 0013): payer, payee, token, amount, condition_ref, status, releasers, threshold, refund_after, refund_to, fee_recipient, fee_bps — IMPLEMENTED (Phase E4 + E5; `releaser` became `releasers`+`threshold` in #119)
release(escrow_id, caller) -> result   // IMPLEMENTED (Phase E2) — a releaser, threshold must be 1, only while Funded
release_with_approvals(escrow_id, approvers) -> result   // IMPLEMENTED (Phase E5, issue #119, ADR 0007) — >= threshold distinct releasers, each authorizing this invocation
refund(escrow_id, caller) -> result    // releaser (threshold 1), stored payee voluntarily while Funded, or anyone after timeout; always pays stored `refund_to` (ADR 0009/0010)
refund_with_approvals(escrow_id, approvers) -> result    // IMPLEMENTED (Phase E5, issue #119) — same approval rules as release_with_approvals
settle_many(caller, ops: Vec<(escrow_id, Release|Refund)>) -> Vec<Result<(), Error>> // IMPLEMENTED (Phase E5, issue #29, ADR 0012) — caller authorizes once; each op gets exactly the checks of release/refund against that escrow's own releasers; best-effort, one result per op in input order (Err = untouched; same escrow twice → second NotFunded); a post-transfer failure (payee callback) reverts the whole batch; at most MAX_SETTLE_OPS = 20 (BatchTooLarge); not deployed on testnet yet
top_up(escrow_id, payer, amount) -> result // IMPLEMENTED (issue #26) — original payer only, funded state only; emits `top_up`
transfer_payee(escrow_id, current_payee, new_payee) -> result // IMPLEMENTED (Phase E5, issue #45) — current payee only, funded state only; new_payee may not be the contract address or the payer; rotation tool, not key-loss recovery
create_pooled_escrow(creator, payee, token, funding_target, condition_ref, releaser, funding_deadline) -> escrow_id // IMPLEMENTED (Phase E5, issue #113, ADR 0011) — pooled escrow; amount starts at 0, `funding_target` > 0 and a strictly-future `funding_deadline` are fixed at creation; not deployed on testnet yet
contribute(escrow_id, payer, amount) -> () // IMPLEMENTED (issue #113) — permissionless before the deadline, up to the target only; balance-delta verified (`transfer_in_exact`) and recorded per payer, accumulating across repeats
claim_refund(escrow_id, contributor) -> () // IMPLEMENTED (issue #113) — pull-based refund, contributor's own auth, only from a failed round (deadline passed, target unmet), pays exactly the recorded amount once (`AlreadyRefunded` after)
get_pooled(escrow_id) -> PooledData  // read-only: funding_target, funding_deadline — errors NotPooled (26) on non-pooled ids
get_contribution(escrow_id, contributor) -> Option<Contribution> // read-only: one contributor's record (amount, refunded); None if never contributed
rotate_releaser(escrow_id, caller, new_releaser) -> result // IMPLEMENTED (issue #23) — single-releaser escrow only; current releaser and payer authorize; funded only
solvency(token) -> (balance, liabilities) // IMPLEMENTED (Phase E5, issue #39) — read-only; liabilities = sum of `amount` over Funded escrows in `token`, kept in persistent `Liability(token)` (TTL re-extended on every write) and updated in the same invocation as every create/top_up/contribute (+) and release/refund/cancel/claim_refund (−); not deployed on testnet yet
```

## Events

The contract emits lifecycle events on every successful `create_escrow*`,
`release*`, and `refund*` call (issue #9, addresses threat-model T7).
Error paths emit nothing — an event is a signal that a state change
actually committed.

Lifecycle events share the same full-state snapshot shape used by the
indexer:

```
Topic:   ("ESCROW", action, escrow_id)
           action  ∈ { "created", "released", "refunded", "cancelled" }
           escrow_id : u64

Payload: (payer, payee, token, amount, condition_ref, releasers, threshold,
          refund_after, notify_payee, requires_acceptance, accepted_at,
          status, (fee_recipient, fee_bps))
```

The status value is the matching `Funded`, `Released`, `Refunded`, or
`Cancelled` symbol. The fee fields are nested because Soroban event tuples
support at most 13 values. `condition_ref` remains opaque: callers must not
put sensitive data in it (threat model T9).

Other emitted events (not lifecycle):
- `top_up`   — topic `("top_up", escrow_id)`,   payload `(added, new_total)`
- `rotate`   — topic `("rotate", escrow_id)`,   payload `(old_releaser, new_releaser)`
- `accepted` — topic `("accepted", escrow_id)`, payload `(payee, accepted_at)`

No new contract-level role came in with the M-of-N work: `releasers` is
escrow data chosen by the payer at creation and immutable afterwards.There is still no admin, no owner, no pause and no upgrade path — OpenZeppelin's
pausable/upgradeable/access modules were evaluated and rejected in
`docs/adr/0006` precisely because they would add one.

Pooled escrows (Phase E5, issue #113, `docs/adr/0011`) are additive: they
live behind `create_pooled_escrow` and two appended storage keys
(`Pooled(id)`, `Contribution(id, address)`), so `EscrowData` and every
existing entry point keep their exact meaning. Rules, all tested in
`contracts/escrow/tests/pooled.rs`: an explicit `funding_target` and
`funding_deadline` are fixed at creation; `contribute` is open to anyone
until the deadline and rejects anything past the target (overfunding is
rejected, not refunded); `release` (both paths) additionally requires
`funded == target` (`FundingIncomplete = 29`), so partial pools never
release — a successful pool releases its whole total to the payee; if
the deadline passes with the target unmet, the round is failed for good
and every contributor pulls back exactly their recorded amount via
`claim_refund`, independently and once each (`AlreadyRefunded = 31`),
with no contributor iteration anywhere (no cap by design — see ADR
0011 "Resource limits"). The push paths `refund`/`refund_with_approvals`/
`cancel`/`top_up` reject pooled escrows (`NotSupportedForPooled = 33`)
because they would route the pool to one address or grow it without a
record; pooled escrows have no `refund_after`. `get_status` keeps its
four-value settlement vocabulary — a failed round stays `Funded`; read
`get_pooled` + the ledger clock for funding state. New errors 26–34 are
append-only (ADR 0011 lists them).

The allowlist is fixed when the contract is deployed. `create_escrow`
rejects any token outside a non-empty list with `DisallowedToken` (error
code 8); an empty list preserves the prior open-token behavior. The
current testnet deployment includes the native XLM SAC and the
BalanceMismatch test token in its immutable allowlist; see
`docs/testnet-deployments.md`.

`create_escrow`'s param order in code is `(payer, payee, token, amount, condition_ref, releaser, refund_after, notify_payee, refund_to, fee_recipient, fee_bps)`.
`notify_payee` opts a contract payee into `on_escrow_released(escrow_id,
amount)`; when true, the payee must authorize creation as well as the payer.
The quorum creation entry point has the same final callback flag. The SDK
option defaults to false. Callback failure rolls release back atomically;
see ADR 0005 for failure, gas, and stored-record compatibility.

The current contract surface (`create_escrow`, `get_status`, `get_escrow`,
`release`, `refund`, payee acceptance, M-of-N quorum, callbacks, and
sponsored refund destinations) is deployed on testnet as of 2026-10-20
(`docs/testnet-deployments.md`, latest entry) — including
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
`refund`, but the destination is unchanged — always the stored
`refund_to`, which is the `payer` unless set otherwise at creation —
and `release` is never gated by it, so the releaser can still release
after the deadline (whoever lands first wins). No `refund_after` means
behaviour is exactly what it was before: releaser-only refunds, forever.
The timeout is the answer to "what if the releaser's key is lost?" (threat
model T2): instead of locking funds permanently, a deadline lets anyone
return them.

`refund_to` (Phase E5, `docs/adr/0009`) is an optional address, set at
creation under the funder's (`payer`'s) auth, that every refund path pays
instead of `payer`. It is stored, immutable, never supplied at payout, and
may not be the contract itself (`InvalidRefundTo`); omitted, it equals
`payer` and behaviour is exactly as before. Invariant I1 is therefore
"release → stored `payee`, refund → stored `refund_to`". Make sure the
destination can hold the token: if the transfer to it fails, so does the
refund.

The optional protocol fee (`fee_recipient`/`fee_bps`, `docs/adr/0010`):
set once at creation, taken **off the top** at `release` —
`⌊amount × fee_bps ÷ 10 000⌋` to `fee_recipient`, the exact remainder to
`payee` — and never on `refund`, which always returns the full `amount`
to `refund_to`. `fee_bps` is capped at `MAX_FEE_BPS` = 1 000 (10 %) with
floor rounding; `fee_recipient` must not be the contract itself; both
params must be given together or both omitted, or creation fails with
`InvalidFee` (error 35). `create_escrow` and `create_escrow_release_time`
take the pair; the acceptance and M-of-N entry points record no fee. A
`top_up` grows the stored `amount`, so it grows the bps fee (the fee math
is re-checked before the top-up transfer). Both fields are readable from
`get_escrow`, and the `ESCROW` event snapshot appends them as one nested
`(fee_recipient, fee_bps)` pair, so payer and payee can check the exact
deal before relying on the escrow.

`release_with_approvals`/`refund_with_approvals` check that at least
`threshold` distinct releasers each authorized this exact invocation.
Approvals are never stored, so nothing can be replayed, and both work
only while the escrow is `Funded`. The payee-acceptance gate
(`docs/adr/0008`) only blocks release: refunds never need acceptance.

The contract decides **who** may call `release`/`refund`, never **why**:
`condition_ref` is opaque to it (`docs/adr/0001`).

`contracts/releaser-account/` provides an optional custom account to use as
the per-escrow `releaser`: an immutable escrow target plus an M-of-N set of
Ed25519 keys. Soroban authorization signatures cover the host-generated
payload, including the nonce and invocation context. The account rejects
authorization contexts other than one `release` or `refund` call on its
configured escrow. Signer additions/removals and threshold changes use a
separate signed management digest bound to the account and a monotonic
management nonce. See [ADR 0005](docs/adr/0005-custom-releaser-account.md).

## TypeScript SDK surface (`sdk/`)
```ts
import { EscrowClient, Keypair } from "@docforum/escrow-sdk";

const client = new EscrowClient({ contractId }); // defaults: testnet RPC + passphrase
const client2 = new EscrowClient({ contractId, network: networks.testnet }); // named preset: RPC URL + passphrase + known contract ids
// networks.futurenet and networks.local are also available; custom networks (private quickstart) still work
// by passing explicit rpcUrl + networkPassphrase. Constructing with the mainnet passphrase throws
// unless allowMainnet: true is passed. With a preset (or verifyNetwork: true) the RPC's getNetwork
// passphrase is verified lazily and once (cached) before the first network call, never in the
// constructor; pass verifyNetwork: true with a custom rpcUrl so it cannot silently point at mainnet
// (verifyNetwork: false turns the check off). Plain-HTTP RPC needs allowHttp (networks.local sets it).
const { escrowId, txHash } = await client.createEscrow({ payer, payee, token, amount, conditionRef, releaser, refundAfter, notifyPayee: true, refundTo, feeRecipient, feeBps });
await client.createQuorumEscrow({ payer, payee, token, amount, conditionRef, releasers, threshold, refundAfter, notifyPayee: true, refundTo }); // M-of-N, ADR 0007
await client.getStatus(escrowId);            // "Funded" | "Released" | "Refunded"
await client.getEscrow(escrowId);            // full stored record — incl. releasers + threshold + refundAfter, refundTo, so a payee can check the deal (docs/adr/0004/0007/0009, threat model T8)
await client.release({ escrowId, caller });  // { txHash } — caller: Keypair or SEP-43 Signer, must be a releaser and threshold must be 1
await client.releaseWithApprovals({ escrowId, approvers }); // { txHash } — one Keypair/Signer per approver (>= threshold, distinct)
await client.refund({ escrowId, caller });   // { txHash } — releaser (threshold 1), the stored payee voluntarily, or anyone after refundAfter
await client.refundWithApprovals({ escrowId, approvers });  // { txHash } — M-of-N refund
await client.getTokenInfo(token);           // { decimals, symbol, name } — cached token metadata read from the SEP-41 contract
await client.getEvents({ fromLedger });      // { events, nextCursor } — decoded lifecycle event page
const stop = client.subscribe(handler, { cursor, pollIntervalMs }); // serial polling; await handler for back-pressure
await client.createMilestoneEscrow({ payer, payee, token, amount, conditionRef, releaser, milestones }); // milestones: bigint[] tranches, validated client-side (sum == amount, all > 0); one escrow per tranche
await client.releaseMilestone({ escrow: group, milestoneIndex, caller }); // releases that tranche's escrow, once
await client.refundMilestone({ escrow: group, milestoneIndex, caller }); // refunds that tranche's escrow, same rules as refund
await client.getMilestones(group);           // [{ index, amount, escrowId, status: "unreleased" | "released" | "refunded" }]
await client.estimate({ source, method, args }); // { resourceFee, inclusionFee, total, minResourceFee } — simulation only, 20% resource buffer
client.guardSponsorship(signedXdr);          // { ok, reasons, invokedContracts } — every op + contract auth entry must target this escrow
client.feeBump(signedXdr, sponsor, { maxFee, baseFee? }); // { xdr, fee, innerTxHash } — throws MaxFeeExceededError, never overshoots the cap
```

Milestones are an SDK-level grouping, not a contract entry point: the
deployed contract is single-tranche, so `createMilestoneEscrow` creates one
ordinary escrow per tranche, tags its `conditionRef` as
`<conditionRef>#m<i+1>/<n>`, and returns the ids. Each tranche therefore
settles independently, release/refund act per tranche, and creation is one
transaction per tranche. `validateMilestoneSchedule` checks the schedule
(positive tranches summing exactly to `amount`, i128-safe) before the first
RPC call and throws `MilestoneScheduleError`; a tag that would exceed the
64-byte `condition_ref` limit is rejected the same way. A failure partway
through throws `MilestoneEscrowPartialError`, which carries the ids of the
tranches already funded so the caller can release or refund them.

`refundTo` on `createEscrow` and `createQuorumEscrow` is optional too (default: the payer) and
`getEscrow` returns it as `refundTo`.
`feeRecipient`/`feeBps` on `createEscrow` are optional as one atomic pair
(both or neither; `feeBps` is an integer `0..=MAX_FEE_BPS`, i.e. at most
10 %), validated client-side before any transaction is built. At release
the floored bps share goes to `feeRecipient` and the remainder to the
payee; refunds never take a fee. `getEscrow` returns
`feeRecipient`/`feeBps` (`undefined` = no fee), and `MAX_FEE_BPS` mirrors
the contract's cap (docs/adr/0010).

Amounts are raw `bigint` in the token's smallest unit. `sdk/src/amounts.ts`
exports `parseAmount(value, decimals)` and `formatAmount(amount, decimals)`
plus `getTokenInfo(token)` (cached `decimals`/`symbol`/`name` read from the
token contract). Parsing is locale-independent and strict: no floats, no
exponent notation, no thousands separators, no negatives, and more
fractional digits than `decimals` is rejected rather than rounded. Never
assume 7 decimals — read them from the token, since arbitrary SEP-41 tokens
may differ.

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
`src/generated/` directly. The package publishes ESM and CommonJS entry
points with declarations for both; browser-aware bundlers use its ESM entry.
Known contract ids per network come from the
repo-root `deployments.json` (written by `scripts/deploy`), bundled as
`src/deployments.generated.ts` and exposed as `knownContractId` /
`knownNetworkConfig`; unknown networks and mainnet throw.
`condition_ref` is an **opaque string/id** the contract does not interpret, bounded to 64 bytes at creation (error `ConditionRefTooLong = 7`; SDK constant `MAX_CONDITION_REF_LENGTH`) — it's the caller's job (e.g. `docforum-core`) to decide when release is warranted and call `release()`. `releaser` is the one address permitted
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

### Contract-account (passkey / smart-wallet) payers

`payer` is an `Address`, so a Soroban contract account (for example a
passkey-backed smart wallet) is a valid payer and the escrow contract needs no
change. what differs is authorization: a `C...` account cannot sign a
transaction envelope, so it authorizes the invocation with a signed **auth
entry** that its own `__check_auth` verifies (secp256r1/WebAuthn for a passkey
wallet).

The SDK's write path signs envelopes, so it covers `G...` payers only; it does
not build or accept auth entries for `C...` payers yet. The flow, the missing
two-step API and the test contract the follow-up needs are written up in
`docs/smart-wallet-auth-flow.md`. The SDK read path (`getEscrow`,
`getStatus`) needs no signer and works for any payer type today.

### Signer interface and browser wallets (issue #127)

`EscrowClient` methods accept either a local `Keypair` or a SEP-43 `Signer`
(`address` + `signTransaction`), so the same `createEscrow`/`release`/`refund`
surface works in Node and in a browser wallet. `sdk/src/signers/wallets-kit.ts`
ships `WalletsKitSigner`, which adapts Stellar Wallets Kit to that interface:

- It is exported on the `@docforum/escrow-sdk/signers/wallets-kit` subpath and
  has **no runtime import** of `@creit.tech/stellar-wallets-kit` (optional peer
  dependency, injected kit). Server imports of the package root therefore never
  pull wallet code; `sideEffects: false` keeps it tree-shakeable.
- A wallet on the wrong network throws `WalletNetworkMismatchError` **before**
  signing.
- A user rejection is a normal SEP-43 outcome (`error.code === -4`), not an
  unhandled throw.
- 12 offline tests in `sdk/tests/signers.test.ts` with a fake kit.

### React hooks (issue #126)

`packages/escrow-react` (`@docforum/escrow-react`) is framework glue only: no
UI components or styling. It depends on TanStack Query v5 as a peer and
requires `EscrowProvider` (client) inside the app's `QueryClientProvider`.

- `useEscrow(id)` polls `getEscrow` and stops at terminal statuses
  (`Released`/`Refunded`).
- `useEscrowActions(signer)` wraps creation/settlement, invalidates the
  matching query, and returns user rejection as `{ status: "rejected" }`.
- `useEscrowTimeline(escrow)` counts down to `refundAfter`. Documented caveat:
  `refund_after` is a ledger timestamp, so a local countdown is advisory;
  pass `ledgerTimeOffsetMs` to align it. The contract, not the countdown,
  authorizes a timeout refund.

### Telemetry (issue #129)

`EscrowClientConfig.instrumentation` / `onEvent` add optional tracing for the
`simulate`, `sign`, `submit` and `confirm` phases. `@opentelemetry/api` is an
optional peer dependency; with no tracer and no `onEvent` the helpers return
before reading a clock or allocating a span. Attributes are contract id,
function, escrow id, transaction hash and retry count. Account addresses are
never included unless `includeAddresses: true` (threat model T9). Tests in
`sdk/tests/instrumentation.test.ts` assert every phase is produced and the
disabled path does no timing work.

### Go client (issue #128)

`sdk-go/` is a separate Go module (`github.com/DocForum/docforum-escrow/sdk-go`)
with `CreateEscrow`, `GetStatus`, `GetEscrow`, `Release` and `Refund`, typed
errors matching the contract's codes, and `big.Int` for i128 amounts. It is an
additive client — the contract and TypeScript SDK are unchanged by it. Offline
unit tests run in CI; integration tests are opt-in and run against a local
quickstart deployment.

## Hard rules
1. **No PHI, ever, anywhere in this repo.** Not in tests, not in example
   fixtures, not in comments. This repo should be safely public and
   understandable with zero healthcare context.
2. Contract logic changes require updated tests beside the affected
   contract (`contracts/escrow/tests/` or
   `contracts/releaser-account/tests/`) before merge — payment logic bugs
   are not "fix in a follow-up" territory.
3. SDK version bumps that change the public API are breaking changes —
   semver strictly, since `docforum-core` pins a version rather than
   tracking latest.
4. Testnet only until a security review has happened. Do not wire mainnet
   contract addresses into the SDK's defaults.

## Roadmap / status
See `ROADMAP.md` in this repo. Live testnet deployment record:
`docs/testnet-deployments.md`.
A failed outbound token transfer during release returns `Undeliverable` and preserves the funded record, allowing the releaser to retry or use the refund path.
