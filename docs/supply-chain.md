# Static analysis and supply-chain gates

Added by issue #107 (ROADMAP Phase E7). This document is the triage record
for the checks in `.github/workflows/ci.yml`: every suppression below has a
reason and an exit condition, so a reviewer can tell an accepted risk from
an oversight.

## What runs

All commands run from `contracts/escrow/`.

| Check | Job name | Tool version | Command |
|---|---|---|---|
| Formatting | `Rust formatting (cargo fmt --check)` | rustfmt 1.96.0 | `cargo fmt --check` |
| Lints | `Rust lints (clippy -D warnings)` | clippy 1.96.0 | `cargo clippy --all-targets -- -D warnings` |
| Soroban static analysis | `Soroban static analysis (Scout)` | `cargo-scout-audit` 0.3.17 | `cargo scout-audit --output-format md --cicd scout-report --exclude ...` |
| Dependencies | `Supply chain (cargo-deny)` | cargo-deny 0.22.0 | `cargo deny check` |
| Advisories | `Supply chain (cargo-audit)` | cargo-audit 0.23.0 | `cargo audit --deny yanked --ignore RUSTSEC-2026-0387` |

The Rust version is pinned twice on purpose: `rust-toolchain.toml` for local
use, and `dtolnay/rust-toolchain@1.96.0` in CI so a new compiler/lint/rustfmt
release cannot turn an unchanged commit red. cargo-deny and cargo-audit are
installed from their release tarballs with a checked-in SHA-256, not
`latest`. Scout is installed from crates.io with `--locked` at 0.3.17.

### Clippy policy

Pedantic lints are enabled in `contracts/escrow/Cargo.toml`. Only three are
allowed, each with a comment next to it there:

| Lint | Why it is allowed |
|---|---|
| `too_many_arguments` | `create_escrow` has eight parameters because that is the on-chain ABI, already live on testnet. The lint also fires on the macro-generated client. Changing the signature for a linter would be a breaking contract change. |
| `similar_names` | `payer`/`payee` are the domain terms in ADR 0001/0002 and part of the public ABI. |
| `needless_pass_by_value` | Soroban entry points and the generated client take `Env`/`Address` by value; references would change the ABI. |

One test-only allowance exists in `tests/malicious_token.rs`:
`used_underscore_binding` on `LyingToken::transfer`, whose unused
`_env`/`_from`/`_to` parameters are read by the generated `contractimpl`
code. All other pedantic findings were fixed, not suppressed (missing
`# Errors` docs, `must_use`, `# Panics`, backticks in docs).

## Scout findings triage

Scout 0.3.17 is the current Soroban analyser. Three detectors are excluded
in CI, with the reasons below; every other detector runs. Each exclusion
is a detector-level suppression, not a blanket "ignore the report": the
`--cicd` flag still writes `scout-report/FAIL` for any finding from an
enabled detector.

**The job is currently report-only.** When `scout-report/FAIL` exists the job
emits a warning, writes the full report to the job summary and uploads it as
the `scout-report` artifact, but it does not fail. The current contract has
an untriaged backlog (11 Critical overflow/underflow findings in
`internal.rs`, `settle.rs`, `storage.rs` and `recurring.rs`; Medium
divide-before-multiply, unbounded-loop, storage-revert and dynamic-storage
findings; 3 Minor). Once each finding is fixed or given a written exclusion
here, restore the `exit 1` in the "Run Scout" step of `ci.yml` so new
findings block again.

| Excluded detector | Severity | Why | Exit condition |
|---|---|---|---|
| `soroban-version` | Enhancement | `soroban-sdk` is pinned at 27.0.6 to match the source of the live testnet deployment. Moving to 28 changes the compiled contract and the generated TypeScript bindings, so it is a separate breaking change tracked under Phase E4 follow-ups, not a CI work item. | Remove this exclusion in the SDK-upgrade PR, after regenerating bindings and redeploying to testnet. |
| `assert-violation` | Enhancement | The contract never uses `assert!`/`panic!`; every failure is an `Error` variant in a `Result`. The only assertions are in `contracts/escrow/tests/`, where panicking on failure is the point. | Remove once Scout can be scoped to library targets only, or if production code ever needs an assertion. |
| `set-contract-storage` | Critical | The detector flags `env.storage()` without a prior `require_auth()` in the same function. `get_status`/`get_escrow` are intentionally unauthenticated read-only views. Every write path (`create_escrow`, `release`, `refund`) calls `require_auth()` before touching storage, and the id allocation was inlined into `create_escrow` after its auth check so no helper writes storage on its own. | Remove the exclusion if the detector gains read/write distinction, or after an independent review confirms the read-only exception is acceptable. |

The release profile sets `overflow-checks = true`, so the arithmetic
findings should abort the transaction rather than wrap, but each one still
needs to be confirmed by hand during triage.

## cargo-deny policy

`contracts/escrow/deny.toml` denies:

- **advisories**: vulnerabilities and yanked crates; `unmaintained` is a
  workspace-level warning because transitive crates can become unmaintained
  without any action in this repo.
- **licenses**: only the permissive list in the file (no copyleft).
- **bans**: duplicate versions (every known duplicate is listed in `skip`
  with a reason, so a *new* duplicate fails), wildcard requirements, and
  git dependencies.
- **sources**: crates.io only.

The single advisory ignored in both cargo-deny and cargo-audit is:

| Advisory | Crate | Why it is ignored | Exit condition |
|---|---|---|---|
| `RUSTSEC-2026-0387` | `crypto-bigint` 0.5.5 via `elliptic-curve` 0.13.8 in `soroban-env-host` | The fixed version (0.7.6) requires an `elliptic-curve`/`soroban-sdk` bump. The affected constant-time arithmetic is host-side test/crypto code and is not reachable from the wasm guest contract; Soroban host execution is deterministic and not observable by a timing attacker. | Revisit on every `soroban-sdk` 27.x/28.x bump; remove the ignore as soon as the SDK pulls the fixed crate. |

## cargo-audit warning triage

`cargo audit` fails on vulnerabilities and, because of `--deny yanked`, on
yanked crates. It also prints these informational warnings. They are
**not** vulnerabilities in this contract's execution path, and all of them
come from `soroban-sdk` 27.0.6's pinned dependency graph, so they cannot be
fixed here without an SDK upgrade:

| Advisory | Crate | Kind | Path / assessment |
|---|---|---|---|
| `RUSTSEC-2026-0543` | `chrono` 0.4.45 | unmaintained | Tooling-only dependency in the SDK's graph; no contract code uses it. |
| `RUSTSEC-2024-0436` | `paste` 1.0.15 | unmaintained | Proc-macro used by `ark-*`/`wasmi_core` in the host/test graph; not in the wasm guest. |
| `RUSTSEC-2026-0574` … `0582` (9 IDs) | `heapless` 0.8.0 | unsound | Reachable through `stellar-strkey` -> `soroban-sdk`, but the affected APIs (`Deque`/Treiber stack) are not used by this contract; the fixed 0.9.x is semver-incompatible with the SDK's pin. |

If any of these becomes a vulnerability or gains a compatible fix, the
audit job will surface it; do not add new ignores without a row here and a
reason in `deny.toml`.

## Required branch-protection checks

The following job names are the required status checks for `main`:

```
Soroban contract (test + wasm build)
TypeScript SDK (typecheck + build)
Rust formatting (cargo fmt --check)
Rust lints (clippy -D warnings)
Soroban static analysis (Scout)
Supply chain (cargo-deny)
Supply chain (cargo-audit)
```

Enabling them is a repository-admin action (Settings -> Branches -> `main`
-> Require status checks); the workflow file cannot set branch protection
itself.

## Bumping a pinned tool

Do it in a dedicated PR and run the gate locally first:

```bash
cd contracts/escrow
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --target wasm32v1-none --release
cargo install cargo-scout-audit --version <new> --locked
cargo scout-audit --exclude soroban-version,assert-violation,set-contract-storage
cargo deny check
cargo audit --deny yanked --ignore RUSTSEC-2026-0387
```

Update the version and checksum in `.github/workflows/ci.yml`,
`rust-toolchain.toml`, and this document in the same commit.
