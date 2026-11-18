# Test and benchmark results

Observed results for the reviewed commit
(`797c1170516847b64ef2b10df3d2abd517248284`). Every command below was run on
that tree; re-run it to confirm — the numbers are a snapshot, not a promise.

Nothing here contains an undisclosed finding. Report findings per
[`SECURITY.md`](../../SECURITY.md).

## Environment

| Item | Value |
|---|---|
| Toolchain | Rust 1.96.0 (pinned in `rust-toolchain.toml`), `wasm32v1-none` target |
| Contract | `contracts/escrow` |
| SDK | `sdk/`, Node 20+ (CI matrix: 20, 22, 24) |
| Network | none — these commands make no testnet calls |

## Contract tests

From `contracts/escrow/`:

```bash
cargo test
```

**108 tests, 0 failed**, across the committed test binaries:

| Binary | Tests | Covers |
|---|---|---|
| `tests/cancel.rs` | 18 | payer cancel before acceptance, its error paths, and the accept/cancel race |
| `tests/create_escrow.rs` | 6 | creation, validation, `get_status` on unknown ids |
| `tests/malicious_token.rs` | 4 | lying/short-delivering token, `BalanceMismatch`, re-entry attempt |
| `tests/payee_acceptance.rs` | 3 | acceptance gate on release, `AcceptanceRequired` |
| `tests/quorum.rs` | 19 | M-of-N creation, thresholds, approvals, duplicates |
| `tests/release_callback.rs` | 6 | `on_escrow_released`, callback failure revert |
| `tests/release_refund.rs` | 7 | release/refund, double-settlement rejection |
| `tests/releaser_rotation.rs` | 3 | `rotate_releaser` auth and one-time rules |
| `tests/sponsored_refund.rs` | 16 | `refund_to` across every refund path |
| `tests/time_locked_release.rs` | 4 | `release_not_before`, `ReleaseTooEarly` |
| `tests/timeout_refund.rs` | 17 | `refund_after` opening to anyone, still to `refund_to` |
| `tests/token_allowlist.rs` | 2 | deploy-time allowlist accept/reject |
| `tests/top_up.rs` | 3 | top-ups, `NotFunded`/`Overflow` guards |

The library unit-test target and doc-tests contain no tests (this is a
`#![no_std]` contract exercised through its public entry points).

### Snapshots

`cargo test` rewrites the committed Soroban snapshots under
`contracts/escrow/test_snapshots/`. CI fails if that produces a diff
(issue #120), so a clean `git status --porcelain -- test_snapshots` after
`cargo test` on this commit is part of the result above.

## WASM build

From `contracts/escrow/`:

```bash
cargo build --target wasm32v1-none --release
test -f target/wasm32v1-none/release/docforum_escrow.wasm
```

- Result: succeeds. The release artifact was 41,308 bytes when this package was
  written, on macOS/aarch64; the byte count of a Linux CI build can differ, so
  use [`scripts/check-wasm-reproducibility.sh`](../../scripts/check-wasm-reproducibility.sh)
  for the reproducible-build claim rather than this number.
- The releaser account contract builds the same way:
  `cargo build --manifest-path ../releaser-account/Cargo.toml --target wasm32v1-none --release`.

## SDK checks

From `sdk/`:

```bash
npm ci
npm run typecheck
npm run build
npm run test:offline
npm run test:unit
```

- `typecheck` and `build`: pass with no errors.
- `test:offline` / `test:unit`: pass (offline only — no network, no testnet).
- `npm run test:integration` deliberately is **not** part of this package: it
  needs live testnet and Friendbot funding, and its results are not
  reproducible from a fixed commit.

## Fuzzing

None. There are no fuzz targets in this commit (`contracts/escrow/fuzz/` does
not exist), so no fuzzing results are reported, and none should be claimed.

## Formal verification

None machine-checked. There is no Certora or equivalent specification in this
commit. Issue #101 tracks a spike; until a run is recorded, treat "formally
verified" as untrue for this contract.

## Costs

The repository commits one cost guard, not a benchmark suite:
[`benchmarks/baseline.json`](../../benchmarks/baseline.json) with
[`scripts/check-resource-baseline.py`](../../scripts/check-resource-baseline.py).

```bash
python3 scripts/check-resource-baseline.py
# resource baseline covers 13 public functions
```

The baseline records a source-size budget per public function and a 20 %
growth threshold; it does not record CPU instructions or memory, and the
committed thresholds are not yet populated. No instruction-count measurements
are committed, so this package makes **no** cost claim beyond "the baseline
script passes for all 13 public functions". A reviewer wanting real figures
should simulate the entry points against the testnet deployment and record the
resource usage in the review.
