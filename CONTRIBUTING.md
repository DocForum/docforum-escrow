# Contributing to docforum-escrow

A Rust/Soroban escrow contract + a thin TypeScript SDK. This repo is
deliberately generic — no healthcare domain logic, no dependency on the
other two repos in the `DocForum` org. This guide is for humans picking
up a scoped issue — if you're an AI coding agent, read `AGENTS.md'
instead.

## 1. Set up locally

Requires a Rust toolchain with the `wasm32v1-none` target.

```bash
git clone https://github.com/DocForum/docforum-escrow.git
cd docforum-escrow/contracts/escrow
cargo test

# Build the deployable contract
cargo build --target wasm32v1-none --release
# → target/wasm32v1-none/release/docforum_escrow.wasm
```

The `stellar` CLI is needed to deploy to testnet yourself (see
`docs/testnet-deployments.md` for the existing deployment) and to
regenerate the SDK's generated bindings
(`scripts/check-generated-bindings.sh`). It is not required just to build
and test the contract; pin the version in `scripts/stellar-cli-version`
when you do need it.

The TypeScript SDK lives in `sdk/`. Install its dependencies and run its
checks with:

```bash
cd sdk
npm ci
npm run typecheck
npm run build
npm run test:offline   # no network: event fixtures + quorum input validation
npm test               # also runs the real-network suite — see below
```

`npm test` includes `tests/integration.test.ts`, which funds accounts through
Friendbot and talks to a real network. `npm run test:integration` points it at
live testnet; `npm run test:integration:local` points it at a local
`stellar/quickstart` network (the same thing CI runs on every PR). Local setup
steps are in the README's "Running the integration suite locally" section.

Run the suite when your change touches network calls. The testnet run needs a
deployment built from the same source as the SDK: the contract id recorded in
`docs/testnet-deployments.md` predates `notify_payee`, acceptance, quorum and
`top_up`, so pointing the suite at it fails with `MismatchingParameterLen`.
Deploy this checkout's WASM to testnet and pass its id (plus
`TESTNET_QUORUM_SUPPORTED=true` to exercise the quorum case):

```bash
cd sdk
ESCROW_TESTNET_CONTRACT_ID=<deployed-contract-id> TESTNET_QUORUM_SUPPORTED=true \
  npm run test:integration
```

The SDK is published to npm as `@docforum/escrow-sdk` via an automated,
provenance-signed release workflow — see [Releasing the SDK](#releasing-the-sdk)
below. The GitHub Release tarball is still attached for existing consumers.

## 2. Find something to work on

Open issues are scoped, real, and tagged with a complexity/point value
(Trivial/100, Medium/150, High/200) in the issue body — see the
[issue list](https://github.com/DocForum/docforum-escrow/issues). Comment
on an issue to claim it before starting, and check it's still open.

ROADMAP.md shows the bigger picture: E1–E3 are done (E2/E4 verified live on
testnet), E4's independent security review is still open and blocking for any
mainnet use, and E5/E7 are the active contract-feature and
verification/release-engineering tracks.

## 3. Before you open a PR

- Tests are required in the same PR as the logic, not a follow-up — see
  `AGENTS.md` hard rule 2. `release`/`refund` in particular need tests
  covering unauthorized-caller and double-release/refund attempts, not
  just the happy path — this is a funds-moving contract.
- If your change starts, completes, or blocks a roadmap-tracked item,
  update `ROADMAP.md` in the same PR.
- Run `cargo test` and `cargo build --target wasm32v1-none --release`
  locally — this is exactly what CI checks.
- `cargo test` also rewrites `contracts/escrow/test_snapshots/`. Review that
  diff (it shows events, auth entries and storage writes) and **commit any
  intentional change** with your PR — CI fails if the committed snapshots no
  longer match a test run. See [Test snapshots](#test-snapshots) below.
- If you changed the contract's public surface, regenerate the SDK bindings and
  run `./scripts/check-generated-bindings.sh`. See
  [Generated SDK bindings](#generated-sdk-bindings).
- For SDK changes, run `npm run typecheck && npm run build` in `sdk/`,
  plus `npm run test:integration` when the change touches network calls.
- Any change to the SDK's public surface is a contract change and needs
  tests and a `changeset` entry (see [Releasing the SDK](#releasing-the-sdk)).
  Strict semver applies to the SDK.

## Test snapshots

The Soroban test environment writes one snapshot per test to
`contracts/escrow/test_snapshots/<test-name>.<n>.json` when the `Env` is
dropped, and those files are committed (issue #120). They make "this PR changed
which events are emitted" or "the storage layout moved" a visible diff instead
of something a reviewer has to infer from the code.

- Update them intentionally: run `cargo test`, inspect
  `git diff contracts/escrow/test_snapshots/`, and commit the change with an
  explanation in the PR. Never hand-edit a snapshot; regenerate by running the
  test.
- Never delete a snapshot to make CI pass. If a test stops producing a
  snapshot, that usually means it no longer touches storage/events — check why.
- Event capture caveat: the SDK clears the event buffer at the start of every
top-level contract invocation, so a snapshot only contains the events of the
test's **last** call. A test that ends with a read (`get_status`, a token
`balance` call, ...) therefore records no events. `tests/top_up.rs`'s
`top_up_emits_an_event` deliberately ends on the emitting call so the event
path stays visible in a diff.
- Snapshots must be deterministic: fresh keypairs come from the SDK's seeded
`Address::generate`, so a second `cargo test` must produce a byte-identical
snapshot. CI's snapshot step catches both drift and nondeterminism.

## Generated SDK bindings

`sdk/src/generated/contract-client.ts` is machine-generated from the compiled
WASM and must never be hand-edited (issue #121). After any change to
`contracts/escrow/src/lib.rs`'s public functions, types or doc comments:

```bash
# Uses the Stellar CLI version pinned in scripts/stellar-cli-version.
./scripts/check-generated-bindings.sh   # prints the regeneration command on drift
```

The `sdk-bindings` CI job rewrites nothing: it fails and tells you to
regenerate. Full steps live in `sdk/src/generated/README.md`. A regenerated
binding that changes the SDK's public surface is also a semver bump
(hard rule 3) and needs a changeset.

## 4. Opening the PR

- Branch off `main`.
- Reference the issue you're closing (`Closes #N`).
- State what changed, why, and which `ROADMAP.md` Item it maps to.
- CI (`cargo test` + wasm release build, plus SDK typecheck/build/test)
  must pass before merge — it runs automatically on your PR.

## Releasing the SDK

The SDK is released by pushing an `sdk-v*` tag (e.g. `sdk-v0.5.0`).
The release workflow (`.github/workflows/release-sdk.yml`) then

1. installs dependencies and runs `typecheck + build + test` for the SDK,
2. refuses to publish if the tag version does not match `sdk/package.json`,
3. publishes to npm with `provenance` via npm trusted publishing (OIDC — no
   long-lived token in secrets), and
4. attaches the `npm pack` tarball to the GitHub Release for existing consumers.

Version bumps and changelogs are managed with [changesets](https://github.com/changesets/changesets). Add a changeset file
with every SDK change:

```bash
npx changeset add
```

Commit the generated `.changeset/*.md` file with your PR. Release managers
run `npx changeset version` to bump `sdk/package.json` and update
`sdk/CHANGELOG.md`, then tag the resulting commit.

### One-time human setup (npm org)

Before the first automated release, a maintainer must do the following once:

1. Create (or join) the `docforum` npm org and ensure the `@docforum`
   scope is available.
2. Configure npm trusted publishing for the `@docforum/escrow-sdk` package,
   pointing at this repository and the release workflow file. Trusted
   publishing uses GitHub Actions OIDC (`id-token: write`) and requires no
   long-lived npm token.
3. If trusted publishing is not yet available for the org, fall back to
   a granular automation token stored as the `NPM_TOKEN` repository secret
   (bypass 2fa) and remove it once trusted publishing is enabled.
4. Enable branch protection so only maintainers can push `sdk-v*` tags.

The release process itself is documented in `docs/adr/0005` (npm publishing),
which supersedes ADR 0003 (tarball-only releases). Note: that ADR file is
referenced by `ROADMAP.md` Phase E6 but is not present in this tree.

## Found a bug instead?

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md), not
a comment on an unrelated issue — keeps scope and Wave points honest.