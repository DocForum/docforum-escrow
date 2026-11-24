# Soroban resource profile

Reproduce with `cargo bench --bench resource_profile` from
`contracts/escrow/`. The harness resets the Soroban budget tracker after
fixture setup and records CPU instructions and memory for one representative
successful call. Each call uses a fresh environment; the single-escrow entries
use a one-address releaser set, a 100-unit escrow, and the same short condition
reference, while the batch, pooled, payee-transfer, pause and solvency entries
use the worst-case fixtures described below. These native host measurements
compare this source with its parent revision; they are not ledger fee quotes.

The before values were measured from the parent revision and the after values
from this branch. For the ten entry points added by issue #320 the two are the
same measurement: that change adds profiling only, does not touch the contract
source, and repeat runs are identical. `benchmarks/baseline.json` contains the
raw measurements.

| Function | CPU before | CPU after | CPU change | Memory before | Memory after | Memory change |
|---|---:|---:|---:|---:|---:|---:|
| `create_escrow` | 469,580 | 494,344 | +5.3% | 154,508 | 167,118 | +8.2% |
| `create_escrow_release_time` | 469,819 | 494,583 | +5.3% | 154,790 | 167,400 | +8.1% |
| `create_escrow_with_acceptance` | 469,584 | 494,348 | +5.3% | 154,508 | 167,118 | +8.1% |
| `create_escrow_with_releasers` | 467,876 | 492,640 | +5.3% | 154,340 | 166,950 | +8.2% |
| `accept` | 144,234 | 143,415 | -0.6% | 65,558 | 65,898 | +0.5% |
| `get_status` | 81,998 | 48,289 | -41.1% | 48,080 | 22,907 | -52.4% |
| `get_escrow` | 92,687 | 92,353 | -0.4% | 49,173 | 49,241 | +0.1% |
| `rotate_releaser` | 168,515 | 169,965 | +0.9% | 74,366 | 74,842 | +0.6% |
| `top_up` | 499,982 | 506,300 | +1.3% | 157,977 | 158,657 | +0.4% |
| `release` | 371,696 | 406,599 | +9.4% | 146,414 | 158,865 | +8.5% |
| `release_with_approvals` | 373,763 | 409,566 | +9.6% | 146,623 | 159,074 | +8.5% |
| `refund` | 374,162 | 402,326 | +7.5% | 140,489 | 152,779 | +8.8% |
| `refund_with_approvals` | 377,529 | 405,382 | +7.4% | 140,791 | 153,081 | +8.7% |
| `create_escrows` | 8,867,986 | 8,867,986 | — | 2,048,839 | 2,048,839 | — |
| `settle_many` | 10,263,023 | 10,263,023 | — | 2,290,599 | 2,290,599 | — |
| `create_pooled_escrow` | 238,018 | 238,018 | — | 111,082 | 111,082 | — |
| `contribute` | 656,604 | 656,604 | — | 228,857 | 228,857 | — |
| `claim_refund` | 539,726 | 539,726 | — | 201,949 | 201,949 | — |
| `cancel` | 461,137 | 461,137 | — | 152,639 | 152,639 | — |
| `transfer_payee` | 187,243 | 187,243 | — | 86,254 | 86,254 | — |
| `pause` | 86,391 | 86,391 | — | 28,102 | 28,102 | — |
| `unpause` | 87,250 | 87,250 | — | 27,950 | 27,950 | — |
| `solvency` | 168,457 | 168,457 | — | 76,963 | 76,963 | — |

## Worst-case batches vs Mainnet limits

The batch fixtures use the most expensive configuration each entry point
accepts. `create_escrows` takes `MAX_BATCH_SIZE` (16) items, each with a
distinct payee, the 64-byte maximum `condition_ref` and a `refund_after`
deadline set; the entry point fixes one releaser per item by shape, so there
is no wider releaser set to measure. `settle_many` releases `MAX_SETTLE_OPS`
(12) escrows, each created with the maximum protocol fee (`MAX_FEE_BPS` =
1,000), an opted-in payee callback (a real contract payee, so the
cross-contract `on_escrow_released` invoke is metered) and the 64-byte maximum
`condition_ref`. A ten-address releaser set cannot be combined with a fee at
creation — only `create_escrow*` takes one — so the releaser-heavy shape is
measured separately.

The Soroban test environment enforces Mainnet's per-invocation limits on
every run, so a batch that exceeds any of them fails here too. The table
reports the modelled footprint and its share of the limits from docs/adr/0012
(events include the return value):

| Batch | Ops | CPU instructions (400M) | Memory | Write entries (200) | Write bytes (132,096) | Events + return (16,384) |
|---|---:|---:|---:|---:|---:|---:|
| `create_escrows` | 16 | 8,867,986 (2.2%) | 2,048,839 | 37 (18.5%) | 17,932 (13.6%) | 11,264 (68.8%) |
| `settle_many` (fee + callback) | 12 | 10,263,023 (2.6%) | 2,290,599 | 40 (20.0%) | 4,844 (3.7%) | 11,680 (71.3%) |
| `settle_many` (10 releasers) | 12 | 6,748,563 (1.7%) | 1,491,850 | 28 (14.0%) | 2,156 (1.6%) | 12,688 (77.4%) |

The events budget is the tightest limit in every case: a worst-case batch
keeps 31.2% headroom for `create_escrows`, 28.7% for the fee + callback
`settle_many` and 22.6% for the ten-releaser shape. The return allowance is
16 bytes per id or result plus 64 bytes of overhead, the same allowance the
`tests/create_escrow.rs` and `tests/settle_many.rs` headroom tests use.
Settled escrows remove their record (ADR 0013), which is why `settle_many`
writes far fewer bytes than `create_escrows` stores.

The ten-releaser batch emits a bigger state event (the full releaser set)
while the fee batch spends more CPU on two token transfers and the callback,
so the fee + callback shape is the CPU worst case and the ten-releaser shape
is the events worst case; both stay under 78% of the events budget.
Issue #319. `cargo bench --bench resource_profile` measures the Soroban native
budget for one representative successful call to each profiled public function
and writes it as JSON, and `scripts/check-resource-baseline.py` fails CI when a
measured cost regresses past `threshold_percent` in `benchmarks/baseline.json`.
Each call uses a fresh environment, a one-address releaser set, a 100-unit
escrow and the same short condition reference; fixture setup is excluded from
the measurement. These native host measurements are not ledger fee quotes.

This replaces the earlier source-size heuristic, which compared a function's
source text with the baseline, so a change that doubled a function's cost while
shrinking its source passed.

## Running the profile

```bash
cd contracts/escrow
cargo bench --bench resource_profile -- --out ../../benchmarks/resource-profile.json
cd ../..
python3 scripts/check-resource-baseline.py
```

`--out <path>` writes the JSON snapshot to a file; without it the JSON goes to
stdout and the human-readable table to stderr. `benchmarks/resource-profile.json`
is generated and gitignored: it is the message, `benchmarks/baseline.json` is
the reviewed record.

The snapshot looks like this:

```json
{"format": 1, "profile_method": "…", "runs": 2, "functions": {
  "create_escrow": {"cpu_instructions": 598556, "memory_bytes": 204421}}}
```

### Determinism

The bench profiles every function `--runs` times (default 2, one fresh
environment each) and exits non-zero when two runs disagree, naming the
function and both numbers. CI runs the profile, so a measurement that isn't
deterministic cannot be compared with the baseline: two matching runs are what
make the check meaningful. `--runs 1` skips the comparison for local
experiments and prints a warning.

## Current baseline

`benchmarks/baseline.json` (format 3) holds, per function, the measured
`cpu_instructions` and `memory_bytes`, plus `threshold_percent` — the allowed
regression on either number (20% today). The check fails a measured increase
past the threshold, fails when a baselined function is no longer measured, and
fails when the profile measures a function the baseline doesn't know, so a new
public function arrives with a reviewed cost.

| Function | CPU instructions | Memory bytes |
|---|---:|---:|
| `accept` | 205,388 | 96,710 |
| `create_escrow` | 598,556 | 204,421 |
| `create_escrow_release_time` | 598,795 | 204,703 |
| `create_escrow_with_acceptance` | 598,552 | 204,389 |
| `create_escrow_with_releasers` | 596,844 | 204,221 |
| `get_escrow` | 129,314 | 67,743 |
| `get_status` | 69,319 | 32,351 |
| `refund` | 492,164 | 156,795 |
| `refund_with_approvals` | 468,631 | 153,995 |
| `release` | 477,290 | 160,287 |
| `release_with_approvals` | 481,769 | 160,496 |
| `rotate_releaser` | 230,220 | 105,915 |
| `top_up` | 640,183 | 209,578 |

## Updating the baseline

Raising the baseline is a review decision, never something CI does implicitly.
It takes the script and a note, and the note goes into the diff:

```bash
cd contracts/escrow
cargo bench --bench resource_profile -- --out ../../benchmarks/resource-profile.json
cd ../..
python3 scripts/update-resource-baseline.py --note "why this cost is accepted"
```

The script prints the old and new cost for every function. `--dry-run` shows the
new file without writing it; `--drop <function>` removes a function that left the
profile (for example a removed entry point) and `--threshold <percent>` changes
the allowed regression. A baseline move must be explained in the PR
description — what got more expensive and why it's accepted — so a reviewer
sees the trade instead of a diff that silently absorbs it.

## Cost drivers

| Function | Main cost drivers |
|---|---|
| `create_escrow` | Auth, token balance reads and transfer, `EscrowData` and status writes |
| `create_escrow_release_time` | Same as `create_escrow`; validates and stores the release timestamp |
| `create_escrow_with_acceptance` | Same as `create_escrow`; validates and stores the acceptance flag |
| `create_escrow_with_releasers` | Token balance reads and transfer, releaser-set validation, `EscrowData` and status writes |
| `accept` | Auth, `EscrowData` read/write, acceptance event |
| `get_status` | One persistent entry read and enum decode; previously read and decoded full `EscrowData` |
| `get_escrow` | Persistent full-record read, decode, and return-value serialization |
| `rotate_releaser` | Two auth checks, `EscrowData` read/write, releaser vector update, event |
| `top_up` | Auth, escrow and pooled-key reads, token balance reads and transfer, `EscrowData` write |
| `release` | Auth, escrow and pooled-key reads, `EscrowData` and status writes, token transfer |
| `release_with_approvals` | Releaser auth checks and membership validation, escrow/pool reads, status writes, token transfer |
| `refund` | Auth, escrow and pooled-key reads, `EscrowData` and status writes, token transfer |
| `refund_with_approvals` | Releaser auth checks and membership validation, escrow/pool reads, status writes, token transfer |
| `create_escrows` | One payer auth, then per item: token balance read and transfer, `EscrowData` and status writes, created event |
| `settle_many` | One caller auth, then per op: escrow/pool reads, releaser check, fee and payout transfers, optional payee callback, status write, event |
| `create_pooled_escrow` | Pause read, allowlist read, validation, auth, `EscrowData`, status and pooled-config writes, event |
| `contribute` | Pause read, escrow and pooled reads, auth, token transfer with exact balance-delta check, contribution and escrow writes |
| `claim_refund` | Auth, escrow, pooled and contribution reads, contribution and escrow writes, token transfer |
| `cancel` | Auth, escrow read, acceptance checks, `EscrowData` and status writes, token transfer |
| `transfer_payee` | Auth, escrow read/write, payee-transfer event |
| `pause` / `unpause` | Auth, pause-admin read, pause-flag write, event |
| `solvency` | Cross-contract token balance read plus the summed `Liability` entry |

Creation is dominated by token balance reads, transfer, auth, and the
persistent record writes. The status index adds one persistent write. The
settlement paths load and write `EscrowData`, authorize the caller, and
transfer tokens; synchronizing the status index adds another persistent
write. `get_status` reads only the compact status enum, while `get_escrow` reads
the full record because it returns that record to callers.

Moving `NextId` to a persistent entry was measured separately and increased
creation costs further, so that candidate was rejected and `NextId` remains
in instance storage.

The status index trades more writes and one persistent entry per escrow for a
much cheaper status read. The contract behavior and public API are unchanged.
The added storage key is a layout change: per ADR 0005, deploy new WASM under a
new testnet contract ID and let existing escrows settle under their original
contract.
