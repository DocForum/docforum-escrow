# ROADMAP.md — docforum-escrow

> Update this file on every contribution that starts/completes/blocks an
> item below.

**Status: Phase E1 done. Phase E2 done and live on testnet. Phase E3's `create_escrow`/`get_status`/`release`/`refund` wrapping done; SDK distribution decided (issue #5 closed — GitHub Release tarball, ADR 0003). Phase E4 (security review, issue #6) in progress: threat model drafted (`docs/threat-model.md`) and the timeout-refund item closed (issue #11 — ADR 0004 + implementation, live on testnet); independent review not yet done — blocking for any mainnet use.**

## Phase E1 — Contract skeleton
- [x] Soroban project scaffold (`contracts/escrow`), builds to wasm
  (`cargo build --target wasm32v1-none --release`) — 4 passing tests in
  `contracts/escrow/tests/create_escrow.rs`.
- [x] Deploy to testnet as a no-op — **done 2026-09-14**. Contract
  `CABSYY5FZGCCZ3UTBQGC7S357D2FUFLUQUUGJCCFHKGEJZVIFK4SIS2Z`, verified live
  (not just deployed): `get_status` on an unknown id correctly errors, and
  a real `create_escrow` call locked 0.5 testnet XLM and reported
  `"Funded"` back. Full record, including the transaction links:
  `docs/testnet-deployments.md`. Closes issue #1.
- [x] `create_escrow` — locks funds (calls the SEP-41 token contract's
  `transfer`), assigns a sequential `escrow_id`, stores payer/payee/amount/
  opaque `condition_ref`, status `Funded`. Rejects non-positive amounts.
  Proven on testnet, not just in local tests — see above.
- [x] `get_status` — read-only status query, errors on unknown id. Proven
  on testnet, not just in local tests — see above.

## Phase E2 — Release & refund
- [x] `release` — restricted to the escrow's `releaser` (set at
  `create_escrow` time, decision recorded in `docs/adr/0002` — a
  per-escrow address, not a single contract-level admin), moves funds to
  payee, only while `Funded`. Closes issue #2.
- [x] `refund` — same auth/state rule, returns funds to payer. Closes
  issue #3.
- [x] Full test suite in `contracts/escrow/tests/release_refund.rs`: 7
  tests — release happy path, release unauthorized, double-release,
  refund happy path, refund unauthorized, refund-after-release,
  release-after-refund. 11/11 tests passing repo-wide (4 existing +
  7 new); wasm release build still succeeds.
- [x] Redeployed to testnet with the new (Phase E2) `create_escrow`
  signature — **done 2026-09-15**. Contract
  `CAXESEEAJILFFCN3PH2HHNMWAAHLEB64UTJHZ6IP7C5BBICT3S3VODSM`, supersedes
  the Phase E1-only deployment (kept as history, not edited). Verified
  live: a real `release` (funds moved to payee), a real `refund` (funds
  returned to payer), and a real unauthorized-caller rejection
  (`Error(Contract, #3)`) — not just the local test suite. Full record:
  `docs/testnet-deployments.md`.

## Phase E3 — TypeScript SDK
- [x] `@docforum/escrow-sdk` wrapping `create_escrow`/`get_status`/
  `release`/`refund`. Closes issue #4. Originally scoped to wrap only
  `create_escrow`/`get_status` (`release`/`refund` didn't exist yet when
  #4 was written) — since Phase E2 landed in the same work session,
  wrapping all four now avoided shipping an SDK immediately stale
  relative to the contract it wraps.
  - `sdk/src/generated/contract-client.ts` — machine-generated via
    `stellar contract bindings typescript --wasm ...` against the local
    wasm build (not the live deployment, so it isn't stale relative to
    source). Never hand-edit; regenerate on contract signature changes.
  - `sdk/src/index.ts` — the actual public surface: an `EscrowClient`
    class accepting a `Keypair` directly as a signer (converted
    internally by `@stellar/stellar-sdk`'s `KeypairSigner`) — no manual
    XDR-signing plumbing exposed to consumers (e.g. `docforum-core`'s
    `payments` module).
- [x] Decided npm vs. GitHub Packages — closes issue #5. **Interim**:
  consumed via a tarball attached to a tagged GitHub Release
  (`sdk-v0.1.0`), not GitHub Packages — that registry requires auth even
  for public packages, which would break `npm ci` for any external Wave
  contributor's fork. (A git-subdirectory dependency was tried first as
  a zero-infrastructure option but doesn't actually work against this
  npm version — see ADR revision note.) Real npm registry publish is the
  long-term goal once publishing credentials exist (an out-of-band human
  step, same category as the Drips Wave application itself). Verified
  end-to-end: installed and imported successfully from
  `docforum-core/backend`. See `docs/adr/0003`.
- [x] Integration test against testnet from the SDK itself, not just the
  contract's own test suite. `sdk/tests/testnet-integration.test.ts` — 3
  tests, all passing against the live Phase E2 deployment: full release
  lifecycle, full refund lifecycle, unauthorized-caller rejection.
  Deliberately **not** wired into `npm test`/CI (`npm run
  test:integration` only) — depends on testnet + Friendbot funding
  liveness, a different reliability profile than this org's other
  "integration" tests (e.g. `docforum-core`'s self-contained embedded-
  Postgres booking test). CI runs `typecheck`+`build` only for the SDK.

## Phase E4 — Security review (blocking for any mainnet use)
- [ ] External or community review before any non-testnet deployment.
  Tracked as issue #6.
- [ ] Documented threat model in `docs/`. Part of issue #6. **In progress:**
  draft in `docs/threat-model.md` (self-written by the implementer, so it
  does not count as the review). Stays unchecked until an independent
  reviewer has gone through it.
- [x] Timeout refund path when the releaser key is lost — issue #11.
  Decided in `docs/adr/0004` (optional `refund_after` set at creation,
  after which **anyone** may refund, still only to `payer`; `release` is
  never gated by it; alternatives compared and payee implications for T8
  recorded), implemented in `contracts/escrow/src/lib.rs` with 17 tests
  in `contracts/escrow/tests/timeout_refund.rs` covering every edge case
  the issue lists. Breaking `create_escrow` change → SDK bindings
  regenerated, `@docforum/escrow-sdk` **0.3.0** (migration notes in ADR
  0004), redeployed to testnet and verified live
  (`docs/testnet-deployments.md`, 2026-10-08 entry). Closes issue #11.
  The threat model's §6 checklist item for this is checked; the
  operational half of T2 (key backup / multisig releaser) remains open.

## Explicitly out of scope for this repo
- Any healthcare-specific logic (see README).
- Fiat on/off-ramp, KYC — that's `docforum-core`'s concern if/when it
  builds general payments (see prior architecture discussion), not this
  repo's.

## Changelog
- 2026-09-09 — Repo created as part of the DocForum 3-repo org split.
- 2026-09-14 — Phase E1 implemented: `create_escrow`/`get_status` on
  `soroban-sdk` 27.0.6, 4 tests passing, wasm build verified. Testnet
  deploy intentionally left undone (needs a funded identity + CLI this
  environment doesn't have) — do not mark E1 fully done until that lands.
- 2026-09-14 — Phase E1 fully closed: deployed to testnet
  (`CABSYY5FZGCCZ3UTBQGC7S357D2FUFLUQUUGJCCFHKGEJZVIFK4SIS2Z`) via the
  `stellar` CLI, and verified live with a real `create_escrow` call (0.5
  testnet XLM, native SAC) followed by `get_status` confirming `"Funded"`.
  See `docs/testnet-deployments.md`. Issue #1 closed.
- 2026-09-14 — Added `.github/ISSUE_TEMPLATE/bug_report.md` (identical
  copy across all three org repos — see `docforum-core`'s changelog for
  the sourcing note: a user-supplied bug-report structure plus
  drips.network's "Creating Meaningful Issues" guide).
- 2026-09-14 — Replaced the placeholder `ci.yml` (`echo "TODO"`,
  `pull_request`-only, never once run — every commit so far went
  straight to `main`) with a real workflow: `cargo test` +
  `cargo build --target wasm32v1-none --release` against the actual
  contract in `contracts/escrow/`, triggered on both push to `main` and
  PRs, with a final check that the wasm artifact actually exists. SDK
  build/test intentionally left out of CI — `sdk/package.json`'s
  `build`/`test` scripts are still `echo TODO` placeholders (issue #4),
  nothing real to validate yet; add them to this workflow when #4 lands.
  Done ahead of a Drips Wave application: a reviewer or prospective
  contributor landing on this repo should see it actually exercising its
  own tests, not a stub.
- 2026-09-15 — General workspace-audit fixes (applied identically across
  all three org repos, see `docforum-core`'s changelog for the full
  rationale): added `CONTRIBUTING.md` (human onboarding — `AGENTS.md` is
  agent-facing, and this repo's contract moves real funds, so it also
  notes reporting security issues privately rather than as a public
  issue, ahead of the planned Phase E4 review); enabled branch protection
  on `main` (real CI check + 1 approval required to merge, force-push/
  deletion disabled, `enforce_admins` left `false` so the maintainer
  isn't blocked). Topics were already added in the prior session.
- 2026-09-15 — Implemented Phase E2: `release()` and `refund()`. Auth
  model decision recorded in `docs/adr/0002` — a per-escrow `releaser`
  address, set at `create_escrow` time, rather than a single
  contract-level admin (reasoning: no single point of control, matches
  who actually knows when to release/refund, stays generic per ADR
  0001, multi-tenant ready). This changed `create_escrow`'s signature
  (added `releaser: Address`) — a breaking change from the Phase E1
  signature already live on testnet; that deployment record stays as
  accurate history, not retroactively edited. 7 new tests in
  `tests/release_refund.rs` covering both functions' happy paths,
  unauthorized-caller rejection, double-release, refund-after-release,
  and release-after-refund. 11/11 tests passing, wasm release build
  verified. `ARCHITECTURE_ESSENTIALS.md` contract-surface table updated.
  Closes issues #2 and #3. **Not yet done:** redeploying to testnet with
  the new signature — Phase E2 is proven in the local test suite only
  so far, not live.
- 2026-09-15 — Redeployed to testnet with the Phase E2 signature
  (`CAXESEEAJILFFCN3PH2HHNMWAAHLEB64UTJHZ6IP7C5BBICT3S3VODSM`, supersedes
  the Phase E1-only deployment) and verified `release`/`refund` live:
  real fund transfers on both paths, plus a real unauthorized-caller
  rejection (`Error(Contract, #3)`) confirmed via the contract's own
  diagnostic events, not just a local assertion. Closes the "not yet
  done" gap from the previous entry. Full record:
  `docs/testnet-deployments.md`.
- 2026-09-15 — Built the TypeScript SDK (`@docforum/escrow-sdk`),
  closing issue #4: `sdk/src/generated/contract-client.ts`
  (machine-generated from the local wasm build via `stellar contract
  bindings typescript`) plus a hand-written `EscrowClient` in
  `sdk/src/index.ts` wrapping all four contract functions — expanded
  from #4's original create_escrow/get_status-only scope since Phase E2
  landed in the same session, so there was no reason to ship an
  immediately-stale SDK. Accepts a `Keypair` directly as a signer (no
  manual XDR signing exposed). 3 real tests in
  `sdk/tests/testnet-integration.test.ts`, all passing against the live
  Phase E2 deployment — full release lifecycle, full refund lifecycle,
  unauthorized-caller rejection — satisfying Phase E3's "integration
  test against testnet from the SDK itself" item. Deliberately kept out
  of `npm test`/CI (`npm run test:integration` only, CI runs
  `typecheck`+`build`) given its dependency on live testnet + Friendbot
  funding, a different reliability profile than this org's other
  self-contained integration tests. `ARCHITECTURE_ESSENTIALS.md` updated
  with the SDK's actual public surface.
- 2026-09-15 — Closed issue #5: decided **not** GitHub Packages (its npm
  registry requires auth even for public packages — would break `npm
  ci` for any external contributor's fork, exactly what the issue
  warned against). First tried an npm git-subdirectory dependency
  (`github:DocForum/docforum-escrow#path:sdk`) as a zero-infrastructure
  option — tested it against `docforum-core` and it failed (npm 10.8.2
  doesn't support the subdirectory selector the way assumed). Replaced
  with a tarball attached to a real tagged GitHub Release (`sdk-v0.1.0`,
  via `npm pack` + `gh release create`) — verified working end-to-end:
  installed and imported successfully from `docforum-core/backend` with
  zero auth. Added a `prepare: npm run build` script to
  `sdk/package.json` (unused by this specific approach, but harmless to
  keep for a future git- or workspace-based route). Real npm
  registry publish remains the long-term goal, blocked on publishing
  credentials this environment doesn't have. See `docs/adr/0003`.
- 2026-09-15 — SDK v0.2.0 (breaking, per hard rule 3): `createEscrow`,
  `release`, and `refund` now also return the transaction's hash
  (`{ escrowId, txHash }` / `{ txHash }`) instead of discarding it —
  needed by `docforum-core`'s payments module to persist
  `stellarTxHash`. All 3 live-testnet tests updated and still passing.
  Republished as GitHub Release `sdk-v0.2.0` (see ADR 0003's release
  process); `docforum-core` updated to depend on the new tarball URL.
- 2026-09-15 — Fixed two real bugs in `docs/adr/0003` that broke
  `docforum-core`'s VitePress docs-site build entirely ("Element is
  missing end tag" — VitePress parses markdown through a Vue template
  compiler, which can misread certain angle-bracket placeholder text as
  an unclosed HTML tag): a placeholder phrase with a space inside
  angle brackets, and — found only after the first fix still didn't
  build — two separate bracketed placeholders inside one inline code
  span. Both rephrased to avoid angle-bracket placeholder syntax
  entirely rather than guessing at a safe form. Caught, and actually
  fixed for real (not just believed fixed), while checking the live
  docs site reflects this session's changes rather than assuming it
  did — verified by building `docforum-core`'s docs site locally against
  this exact file, twice, before trusting it.
- 2026-09-26 — Updated the stale top status line (still said issue #5
  was open; it closed 2026-09-15).
- 2026-10-01 — Drafted `docs/threat-model.md` for Phase E4 (issue #6):
  invariants, actors, ten threats with severity, SDK and consumer
  integration notes, and a proposed pre-mainnet checklist. No contract
  changes. Self-written, so E4 stays open pending independent review.
- 2026-10-08 — Closed issue #11 (Phase E4: timeout refund path when the
  releaser key is lost). **ADR first:** `docs/adr/0004` picks the threat
  model's candidate — an optional `refund_after` unix timestamp set at
  `create_escrow`, after which anyone may `refund`, always only back to
  `payer` — and compares it against a privileged unlock role, releaser
  rotation, and doing nothing; it also spells out what the deadline means
  for payees (T8): the commitment expires, `get_escrow` lets them read
  it, and the new risk is bounded to "delayed then reversed", never
  redirected. **Implementation:** `refund_after: Option<u64>` added to
  `create_escrow` (rejects a deadline not strictly in the future — new
  `Error::InvalidRefundAfter = 5`), `refund` accepts any caller once the
  deadline has passed (state rules unchanged: still `Funded` only),
  `release` deliberately *not* gated by the deadline (the releaser keeps
  its right; whoever lands first wins, the loser gets `NotFunded`), plus
  a read-only `get_escrow` so the deadline is inspectable on-chain. With
  no `refund_after`, behaviour is exactly what it was before. **Tests:**
  17 new in `tests/timeout_refund.rs` covering every edge case issue #11
  lists (release in the same ledger the timeout passes — both orders;
  deadline already past at creation; already released/refunded before the
  timeout; no deadline at all) — 28/28 passing repo-wide, wasm release
  build verified. **Breaking change:** `create_escrow`'s signature and
  `EscrowData`'s layout both changed, so the contract was redeployed to
  testnet (`CAHQ4J3T23WSIBBG6SI6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEV5`,
  supersedes the Phase E2 deployment, kept as history) and verified live
  with a real non-releaser timeout refund after the deadline, a real
  release after the deadline, and real rejections for a pre-deadline
  stranger refund (`#3`), a past deadline at creation (`#5`) and a second
  refund (`#4`) — full record with tx links in
  `docs/testnet-deployments.md`. **SDK:** bindings regenerated from the
  new wasm (never hand-edited), `@docforum/escrow-sdk` **0.2.0 → 0.3.0**
  (breaking, per hard rule 3; same 0.x-minor-for-breaking convention as
  0.1.0 → 0.2.0), adding optional `refundAfter` on `createEscrow` and a
  `getEscrow()` accessor; migration steps for `docforum-core` are in ADR
  0004. All 5 SDK integration tests pass against the new deployment
  (`npm run test:integration`, still kept out of CI).
  `ARCHITECTURE_ESSENTIALS.md`, `README.md` and `docs/threat-model.md`
  (§1 invariants, T2, T8, §6) updated. **Not done:** publishing the
  `sdk-v0.3.0` release tarball per ADR 0003 — that's the follow-up step
  before `docforum-core` can consume it.
