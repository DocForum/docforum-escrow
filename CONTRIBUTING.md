# Contributing to docforum-escrow

A Rust/Soroban escrow contract + a thin TypeScript SDK. This repo is
deliberately generic — no healthcare domain logic, no dependency on the
other two repos in the `DocForum` org. This guide is for humans picking
up a scoped issue — if you're an AI coding agent, read `AGENTS.md`
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

The TypeScript SDK (`sdk/`) is currently a placeholder (see issue #4) —
its `build`/`test` scripts are stubs until that issue lands.

## 2. Find something to work on

Open issues are scoped, real, and tagged with a complexity/point value
(Trivial/100, Medium/150, High/200) in the issue body — see the
[issue list](https://github.com/DocForum/docforum-escrow/issues). Comment
on an issue to claim it before starting, and check it's still open.

`ROADMAP.md` shows the bigger picture: Phase E1 (contract skeleton) is
done and verified live on testnet; E2 (release/refund) is the current
open work.

## 3. Before you open a PR

- Tests are required in the same PR as the logic, not a follow-up — see
  `AGENTS.md` hard rule 2. `release`/`refund` in particular need tests
  covering unauthorized-caller and double-release/refund attempts, not
  just the happy path — this is a funds-moving contract.
- If your change starts, completes, or blocks a roadmap-tracked item,
  update `ROADMAP.md` in the same PR.
- Run `cargo test` and `cargo build --target wasm32v1-none --release`
  locally — this is exactly what CI checks.

## 4. Opening the PR

- Branch off `main`.
- Reference the issue you're closing (`Closes #N`).
- State what changed, why, and which `ROADMAP.md` item it maps to.
- CI (`cargo test` + wasm release build) must pass before merge — it
  runs automatically on your PR.

## Found a bug instead?

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md), not
a comment on an unrelated issue — keeps scope and Wave points honest.
Given this contract moves funds, please report anything that looks like
a security issue (not just a functional bug) privately rather than as a
public issue — see `ROADMAP.md` Phase E4 for the planned formal security
review process.
