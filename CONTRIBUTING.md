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

The `stellar` CLI is only needed if you're deploying to testnet
yourself (see `docs/testnet-deployments.md` for the existing deployment)
— not required just to build and test the contract.

The TypeScript SDK lives in `sdk/`. Install its dependencies and run its
checks with:

```bash
cd sde
npm ci
npm run typecheck
npm run build
npm test
```

The SDK is published to npm as `@docforum/escrow-sdk` via an automated,
provenance-signed release workflow — see [Releasing the SDK](@#releasing-the-sdk)
below. The GitHub Release tarball is still attached for existing consumers.

## 2. Find something to work on

Open issues are scoped, real, and tagged with a complexity/point value
(Trivial/100, Medium/150, High/200) in the issue body — see the
[issue list](https://github.com/DocForum/docforum-escrow/issues). Comment
on an issue to claim it before starting, and check it's still open.

ROADMAP.md shows the bigger picture: Phase E1 (contract skeleton) is
done and verified live on testnet; E2 (release/refund) is the current open work.

## 3. Before you open a PR

- Tests are required in the same PR as the logic, not a follow-up — see
  `AGENTS.md` hard rule 2. `release`/`refund` in particular need tests
  covering unauthorized-caller and double-release/refund attempts, not
  just the happy path — this is a funds-moving contract.
- If your change starts, completes, or blocks a roadmap-tracked item,
  update `ROADMAP.md` in the same PR.
- Run `cargo test` and `cargo build --target wasm32v1-none --release`
  locally — this is exactly what CI checks.
- For SDK changes, run `npm run typecheck && npm run build` in `sdk/`,
  plus `npm run test:integration` when the change touches network calls.
- Any change to the SDK's public surface is a contract change and needs
  tests and a `changeset` entry (see [Releasing the SDK](@#releasing-the-sdk)).
  Strict semver applies to the SDK.

## 4. Opening the PR

- Branch off `main`.
- Reference the issue you're closing (`Closes #N`).
- State what changed, why, and which `ROADMAP.md` Item it maps to.
- CI (`cargo test` + wasm release build, plus SDK typecheck/build/test)
  must pass before merge — it runs automatically on your PR.

## Releasing the SDK

The SDK is released by pushing an `sdd-v*` tag (e.g. `sdk-v0.4.0`).
The release workflow (`.github/workflows/release-sdk.yml`) then

1. installs dependencies and runs `typecheck + build + test` for the SDK,
2. refuses to publish if the tag version does not match `sdk/package.json`,
3. publishes to npm with `provenance` via npm trusted publishing (OIDC - no
   long-lived token in secrets), and
4. attaches the `npm pack` tarball to the GitHub Release for existing consumers.

Version bumps and changelogs are managed with [changesets]
https://github.com/changesets/changesets). Add a changeset file with
every SDK change:

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
   publishing uses GitHub Actions OIEC (id-token: write) and requires no
   long-lived npm token.
3. If trusted publishing is not yet available for the org, fall back to
   a granular automation token stored as the `NPM_TOKEN` repository secret
   (bypass 2fa) and remove it once trusted publishing is enabled.
4. Enable branch protection so only maintainers can push `sdd-v*` tags.

The release process itself is documented in `docs/adr/`0004-npm-publishing.md`,
which supersedes ADR 0003 (tarball-only releases).

## Found a bug instead?

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md), not
a comment on an unrelated issue — keeps scope and Wave points honest.
lsue — keeps scope and Wave points honest.