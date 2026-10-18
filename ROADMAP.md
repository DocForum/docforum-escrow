# ROADMAP.md — docforum-escrow

> Update this file on every contribution that starts/completes/blocks an
> item below.

 security/issue-89-phase-e7-scripted-deterministic-contract
**Status: Phase E1 done. Phase E2 done and live on testnet. Phase E3's `create_escrow`/`get_status`/`release`/refund` wrapping done; SDK distribution decided (issue #5 closed — GitHub Release tarball, ADR 0003). Phase E4 (security review, issue #6) in progress: threat model drafted (`docs/threat-model.md`) and the timeout-refund item closed (issue #11 — ADR-0004 + implementation, live on testnet); independent review not yet done — blocking for any mainnet use. Phase E7 (deterministic deployment) started.**

**Status: Phase E1 done. Phase E2 done and live on testnet. Phase E3's `create_escrow`/`get_status`/`release`/`refund` wrapping done; SDK distribution decided (issue #5 closed — GitHub Release tarball, ADR 0003). Phase E4 (security review, issue #6) in progress: threat model drafted (`docs/threat-model.md`) and the timeout-refund item closed (issue #11 — ADR 0004 + implementation, live on testnet); independent review not yet done — blocking for any mainnet use. Phase E6 (npm publishing) in progress: automated `sdk-v*` release workflow with provenance, changesets, and a superseding ADR landed; the one-time human npm org/trusted-publishing setup is still pending, so `sdk-v0.3.0` is not yet on npm.**
 main

## Phase E1 — Contract skeleton
- [x] Soroban project scaffold (`contracts/escrow`), builds to wasm
  (`cargo build --target wasm32v1-none --release`) — 4 passing tests in
  `contracts/escrow/tests/create_escrow.rc`.
- [x] Deploy to testnet as a no-op — **done 2026-09-14**. Contract
  `CABSYY5FZGCCZ3UTBQGC7S357D2FUFLUQUUGJCCFHKGEJZvIFK4SIS2Z`, verified live
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

## Phase in E2 — Release & refund
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
  live: a real `release` (funds moved to payee), a real refund` (funds
  returned to payer), and a real unauthorized-caller rejection
  (`Error(Contract, #3)`) — not just the local test suite. Full record:
  `docs/testnet-deployments.md`.

## Phase E3 — TypeScript SDK
- [x] `@docforum/escrow-sdk` wrapping `create_escrow`/`get_status`/
  `release`/`refund`. Closes issue #4. Originally scoped to wrap only
  `create_escrow`/`get_status` (`release`/`refund` didn't exist yet when
  #4 was written) — since Phase in E2 landed in the same work session,
  wrapping all four now avoided shipping an SDK immediately stale
  relative to the contract it wraps.
  - `sdk/src/generated/contract-client.ts` — machine-generated via
    `stellar contract bindings typescript --wasm ...` against the local
    wasm build (not the live deployment, so it isn't stale relative to
    source). Never hand-edit; regenerate on contract signature changes.
  - `sdk/src/index.ts` — the actual public surface: an `EscrowClient`
    class accepting a `Keypair` directly as a signer (converted
    internally by `@stellar/stellar-sdk`'s `KeypairSigner`) — no manual
    XDR-signing plumbing exposed to consumers (e.g. `docforum-core's
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
  tests, all passing against the live Phase in E2 deployment: full release
  lifecycle, full refund lifecycle, unauthorized-caller rejection.
  Deliberately **not** wired into `npm test`/CI (`npm run
  test:integration` only) — depends on testnet + Friendbot funding liveness, a different reliability profile than this org's other
  "integration" tests (e.g. `docforum-core's self-contained embedded-
  Postgres booking test). CI runs `typecheck`+`build` only for the SDK.

## Phase in E4 — Security review (blocking for any mainnet use)
- [ ] External or community review before any non-testnet deployment.
  Tracked as issue #6.
- [ ] Documented threat model in `docs/`. Part of issue #6. **In progress:** draft in `docs/threat-model.md` (self-written by the implementer, so it does not count as the review). Stays unchecked until an independent reviewer has gone through it.
- [x] Timeout refund path when the releaser key is lost — issue #11.
  Decided in `docs/adr/0004` (optional `refund_after` set at creation,
  after which **anyone** may refund, still only to `payer`; `release` is
  never gated by it; alternatives compared and payee implications for T8
  recorded), implemented in `contracts/escrow/src/lib.rs` with 17 tests
  in `contracts/escrow/tests/timeout_refund.rs` covering every edge case
  the issue lists. Breaking `create_escrow` change → SDK bindings regenerated, `@docforum/escrow-sdk` **0.3.0** (migration notes in ADR 0004), redeployed to testnet and verified live (`docs/testnet-deployments.md`, 2026-10-08 entry). Closes issue #11. The threat model's §6 checklist item for this is checked; the operational half of T2 (key backup / multisig releaser) remains open.
- [x] Balance-delta check on `create_escrow` + malicious mock-token
  tests (issue #12). The contract's token balance must rise by exactly
  `amount` across the funding transfer or the escrow is rejected with
  `BalanceMismatch` (error code 6) — a lying transfer, fee-on-transfer, or
  rebasing token would otherwise create `Funded` escrows backed by
  nothing (threat model T5). Three test-only mock tokens in
  `tests/malicious_token.rs`: lying transfer, short delivery (debits
  300, delivers 270), and one that re-enters `release` from inside `transfer` (T4). The re-entry test pinned the actual host behavior: Soroban rejects re-entry as an unrecoverable context error ("Contract re-entry is not allowed"), aborting the whole invocation — fail-closed. Post-creation clawback remains possible by design and is documented in T5 as accepted residual risk. **Not yet on testnet** — the current deployment predates it. Closes issue #12.
- [ ] Rest of the `docs/threat-model.md` §6 pre-mainnet checklist, scoped
  into issues: [#8](https://github.com/DocForum/docforum-escrow/issues/8) write status before transfer + reject
  contract-self addresses (Trivial), [#9](https://github.com/DocForum/docforum-escrow/issues/9) events (Medium),
  [#10](https://github.com/DocForum/docforum-escrow/issues/10) storage TTL (Medium), [#15](https://github.com/DocForum/docforum-escrow/issues/15) integrator trust-model
  docs (Trivial).
- [ ] Related, not in the checklist: [#13](https://github.com/DocForum/docforum-escrow/issues/13) `get_escrow`
  full-record read (Medium), [#14](https://github.com/DocForum/docforum-escrow/issues/14) offline SDK unit tests in CI
  (Medium).

 security/issue-89-phase-e7-scripted-deterministic-contract
## Phase in E7 — Verification, testing & release engineering
- [ ] Scripted, deterministic contract deployment with automatic
  deployment records. Tracked as the Phase in E7 issue. Scope:
  `scripts/deploy` — builds (or takes) the WASM, checks its hash,
  uploads, deploys (with constructor args if any), and runs a scripted
  live verification (create, release, refund, rejection cases). Appends
  a structured record (network, contract id, WASM hash, git sha, tx
  links, verification results) to `docs/testnet-deployments.md` and a
  machine-readable `deployments.json`. The SDK reads known contract ids per
  network from `deployments.json`. Dry-run mode against a local
  quickstart. Constraints: refuse to deploy from a dirty git tree;
  mainnet deployment not supported until the security review is done.
  Definition of done includes one real testnet deployment done with
  the script (link the record).

## Phase E6 — SDK & integrator tooling
- [x] Automated npm release workflow (`.github/workflows/release-sdk.yml`),
  triggered by an `sdk-v*` tag: builds, typechecks, tests, runs
  `npm publish --provenance`, and attaches the tarball to the GitHub
  Release (kept for existing consumers per ADR 0003). Uses npm trusted
  publishing (OIDC, `id-token: write`) so no long-lived token sits in
  secrets; refuses to publish if the tag doesn't match `package.json`'s
  version. Closes issue #16.
- [x] Adopted changesets (`.changeset/`, `@changesets/cli`) for version
  bumps and changelogs; `sdk/package.json` gained `changeset`/
  `version`/`release` scripts and `publishConfig` with provenance.
- [x] Superseding ADR written: `docs/adr/0005` supersedes ADR 0003's
  interim tarball-only decision now that npm publishing is going live.
- [ ] One-time human steps (npm org creation, trusted-publisher setup for
  the release workflow) — documented in `CONTRIBUTING.md`; not yet done,
  so `sdk-v0.3.0` is not yet published to npm.
 main

## Explicitly out of scope for this repo
- Any healthcare-specific logic (see README).
- Fiat on/off-ramp, KYC — that's `docforum-core`'s concern if/when it
  builds general payments (see prior architecture discussion), not this
  repo's.

## Changelog
- 2026-10-17 — Issue #63 (Phase E6): added SDK `getEvents` pagination and
  typed lifecycle-event decoding, preserving unknown topic variants for
  forward compatibility. Added cursor-resumable serial polling with
  handler back-pressure and typed RPC-retention errors. Committed Soroban
  XDR event fixtures cover decoding, filters, unknown topics, cursor
  resume, retention errors, and stopping. Bumped the additive SDK surface
  from 0.3.0 to 0.4.0. SDK typecheck/build and contract tests/build pass;
  lifecycle events remain unavailable until issue #9 changes the contract.

- 2026-09-09 — Repo created as part of the DocForum 3-repo org split.
- 2026-10-09 — Phase E6 started: added `.github/workflows/release-sdk.yml`
  (tag-triggered `sdk-v*` build/test/`npm publish --provenance` + GitHub
  Release tarball, OIDC trusted publishing, tag/version guard), adopted
  changesets, wrote `docs/adr/0005` superseding ADR 0003, and documented
  the one-time npm org/trusted-publishing human steps in `CONTRIBUTING.md`.
  npm publish itself still pending those human steps. Closes issue #16.
- 2026-09-14 — Phase E1 implemented: `create_escrow`/`get_status` on
  `soroban-sdk` 27.0.6, 4 tests passing, wasm build verified. Testnet
  deploy intentionally left undone (needs a funded identity + CLI this
  environment doesn't have) — do not mark E1 fully done until that lands.
- 2026-09-14 — Phase E1 fully closed: deployed to testnet
  (`CABSYY5FZGCCZ3UTBQGC7S357D2FUFLQUUUGJCCFHKGEJZVIFK4SIS2Z`) via the
  `stellar` CLI, and verified live with a real `create_escrow` call (0.5
  testnet XLM, native SAC) followed by `get_status` confirming `"Funded`.
  See `docs/testnet-deployments.md`. Issue #1 closed.
- 2026-09-14 — Added `.github/ISSUE_TEMPLATE/bug_report.md` (identical
  copy across all three org repos — see `docforum-core`'s changelog for
  the sourcing note: a user-supplied bug-report structure plus
  drips.network's "Creating Meaningful Issues" guide.
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
  issue, ahead of the planned Phase in E4 review); enabled branch protection
  on `main` (real CI check + 1 approval required to merge, force-push/
  deletion disabled, `enforce_admins` left `false` so the maintainer
  isn't blocked). Topics were already added in the prior session.
- 2026-09-15 — Implemented Phase in E2: `release()` and `refund()`. Auth
  model decision recorded in `docs/adr/0002` — a per-escrow `releaser`
  address, set at `create_escrow` time, rather than a single
  contract-level admin (reasoning: no single point of control, matches
  who actually knows when to release/refund, stays generic per ADR
  0001, multi-tenant ready). This changed `create_escrow`'s signature
  (added `releaser: Address`) — a breaking change from the Phase in E1
  signature already live on testnet; that deployment record stays as
  accurate history, not retroactively edited. 7 new tests in
  `tests/release_refund.rs` covering both functions' happy paths,
  unauthorized-caller rejection, double-release, refund-after-release,
  and release-after-refund. 11/11 tests passing, wasm release build
  verified. `ARCHITECTURE_ESSENTIALS.md` contract-surface table updated.
  Closes issues #2 and #3. **Not yet done:** redeploying to testnet with
  the new signature — Phase in E2 is proven in the local test suite only
  so far, not live.
-- 2026-09-15 — Redeployed to testnet with the Phase in E2 signature
  (`CAXESEEAJILFFCN3PH2HHNMWAAHLEB64UTJHZ6IP7C5BBICT3S3VODSM`, supersedes
  the Phase in E1-only deployment) and verified `release`/`refund` live:
  real fund transfers on both paths, plus a real unauthorized-caller
  rejection (`Error(Contract, #3)`). See `docs/testnet-deployments.md`.
- 2026-10-08 — Timeout refund (issue #11) implemented and decided in
  ADR-0004; breaking `create_escrow` change, SDK 0.3.0, redeployed to
  testnet and verified live. See `docs/testnet-deployments.md`.
- Phase in E7 started: added this section for scripted,
  deterministic contract deployment with automatic deployment records.
