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

Scout 0.3.17 is the current Soroban analyser. Four detectors are excluded
in CI, with the reasons below; every other detector runs. Each exclusion
is a detector-level suppression, not a blanket "ignore the report": the
`--cicd` flag still writes `scout-report/FAIL` for any finding from an
enabled detector.

**The job is blocking.** It fails when `scout-report/FAIL` exists (any
finding from an enabled detector), and also when the report's status for
`docforum_escrow` is anything other than `Analyzed`. The second check is
needed because `--cicd` removes `FAIL` whenever there are no findings,
including when the crate failed to compile and nothing was checked. The
report is always written to the job summary and uploaded as the
`scout-report` artifact.

The job caches only the `cargo-scout-audit` binary. Scout fetches its
detectors from the `develop` branch of `CoinFabrik/scout-audit` at run time
and builds them inside `~/.cargo/git`. When the job also cached
`~/.cargo/git`, it restored stale prebuilt detectors and every run ended in
"Compilation errors" with zero findings, which passed silently. The detectors
are therefore not pinned by the 0.3.17 version. If an upstream detector
change breaks or changes the analysis, the status check above turns the job
red instead of letting it pass.

| Excluded detector | Severity | Why | Exit condition |
|---|---|---|---|
| `soroban-version` | Enhancement | `soroban-sdk` is pinned at 27.0.6 to match the source of the live testnet deployment. Moving to 28 changes the compiled contract and the generated TypeScript bindings, so it is a separate breaking change tracked under Phase E4 follow-ups, not a CI work item. | Remove this exclusion in the SDK-upgrade PR, after regenerating bindings and redeploying to testnet. |
| `assert-violation` | Enhancement | The contract never uses `assert!`/`panic!`; every failure is an `Error` variant in a `Result`. The only assertions are in `contracts/escrow/tests/`, where panicking on failure is the point. | Remove once Scout can be scoped to library targets only, or if production code ever needs an assertion. |
| `dos-unexpected-revert-with-storage` | Medium | All 11 hits are `push_back`/`set` on a local, in-memory soroban `Vec`/`Map`: the releaser list built for a creation call (`attestation.rs`, `create.rs`, `pooled.rs`, `recurring.rs`), the `seen` duplicate check in `check_releaser_set`, the `get_escrows` result list (capped at `MAX_GET_ESCROWS`), and the legacy-layout upgrade map in `layout.rs`. None of them is a storage entry, so no caller can grow stored state through them. | Remove the exclusion if the detector learns to tell host-object `Vec`/`Map` values from storage, or if the contract ever stores a growable collection. |
| `set-contract-storage` | Critical | The detector flags `env.storage()` without a prior `require_auth()` in the same function. `get_status`/`get_escrow` are intentionally unauthenticated read-only views. Every write path (`create_escrow`, `release`, `refund`) calls `require_auth()` before touching storage, and the id allocation was inlined into `create_escrow` after its auth check so no helper writes storage on its own. | Remove the exclusion if the detector gains read/write distinction, or after an independent review confirms the read-only exception is acceptable. |

Two false positives are allowed on a single function each, with
`#[allow(unknown_lints, <lint>)]` next to a comment, instead of excluding
the whole detector. `unknown_lints` keeps rustc and clippy quiet about a lint
that only exists under Scout.

| Allowed lint | Where | Why |
|---|---|---|
| `divide_before_multiply` | `EscrowContract::split_share` (`internal.rs`) and `EscrowContract::vested_amount` (`storage.rs`) | Both compute `floor(x * n / d)` as `(x / d) * n + floor((x % d) * n / d)`. This is an exact identity, not a rounding shortcut, and it avoids an `i128` overflow of `x * n` at very large amounts. Unit tests in both modules check it against the direct formula for normal inputs and against exact values at `i128::MAX`. |
| `dynamic_storage` | `__constructor` (`admin.rs`) | The token allowlist is a `Vec<Address>` written once, by the deployer, at deployment. There is no setter, so no caller can grow it afterwards. |

### Triage of the 0.3.17 backlog

The full list from the last run that analyzed `main` (28 findings) and what
happened to each one. The release profile sets `overflow-checks = true`, so
none of the arithmetic findings could wrap. At worst they trapped the
invocation. Each one now returns an existing `Error` variant instead, and
none of those errors is reachable with valid state.

| Finding | Severity | Verdict |
|---|---|---|
| `internal.rs` vesting refund `amount - unpaid_vested` | Critical | Fixed: `unpaid_vested` is clamped to `0..=amount`, then `checked_sub` → `Overflow`. |
| `internal.rs` `payout = payee_amount - fee` | Critical | Fixed: `checked_sub` → `InvalidFee`. |
| `internal.rs` split loop `index + 1` | Critical | Fixed: the loop iterates the payee list directly, so the index arithmetic is gone. |
| `internal.rs` split share `whole + fraction / BASIS_POINTS` | Critical | Fixed: moved into `split_share` with `checked_*` → `SplitAmountOverflow`. Results are unchanged. |
| `recurring.rs` `schedule_id + 1` | Critical | Fixed: `checked_add` → `Overflow`. |
| `settle.rs` `amount - payee_amount` | Critical | Fixed: `checked_sub` → `InvalidSettlementAmount`. |
| `settle.rs` `payee_amount - fee` | Critical | Fixed: `checked_sub` → `InvalidSettlementAmount`. |
| `storage.rs` `next_id` `id + 1` | Critical | Fixed: `next_id` returns `Result`, and `checked_add` → `Overflow`. |
| `storage.rs` `vested_amount` `end - start`, `now - start` and the final sum (3) | Critical | Fixed: `checked_*` → `Overflow`. `vested_amount` returns `Result`. Results are unchanged. |
| `internal.rs` divide-before-multiply in the split share | Medium | False positive, allowed on `split_share` (see above). |
| `internal.rs` unbounded loop over `payees` | Medium | Fixed: the loop iterates the list, which creation caps at `MAX_PAYEES` (8) and nothing grows later. |
| `dos-unexpected-revert-with-storage` (11) | Medium | False positive: detector excluded (see the table above). |
| `admin.rs` dynamic storage (allowlist) | Medium | Accepted, allowed on `__constructor` (see above). |
| `storage.rs` unused-return-enum (3, `transfer_in_exact` / `transfer_from_exact`) | Minor | Fixed: the `Ok` path is now explicit (`add_liability(..)?; Ok(())`). No behaviour change. |

The fixes also surfaced one new divide-before-multiply hit, on the same
exact split in `vested_amount`, which was rewritten with checked operations.
It is allowed the same way.

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
