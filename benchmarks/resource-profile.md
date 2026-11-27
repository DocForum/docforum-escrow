# Soroban resource profile

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

| Batch | Ops | CPU instructions (400M) | Memory | Write entries (200) | Write bytes (132,096) | Event bytes (16,384 incl. return) |
|---|---:|---:|---:|---:|---:|---:|
| `create_escrows` | 16 | 8,960,447 (2.2%) | 2,116,299 | 37 (18.5%) | 18,636 (14.1%) | 10,944 + return |
| `settle_many` (fee + callback) | 12 | 10,445,336 (2.6%) | 2,335,616 | 40 (20.0%) | 4,844 (3.7%) | 11,424 + return |
| `settle_many` (10 releasers) | 12 | 6,937,643 (1.7%) | 1,528,107 | 28 (14.0%) | 2,156 (1.6%) | 12,432 + return |

The events budget is the tightest limit in every case. With the return
allowance (16 bytes per id or result plus 64 bytes of overhead, the same
allowance the `tests/create_escrow.rs` and `tests/settle_many.rs` headroom
tests use) a worst-case batch keeps 31.2% headroom for `create_escrows`,
28.7% for the fee + callback `settle_many` and 22.6% for the ten-releaser
shape. The bench prints these footprints on stderr (`events_bytes`,
`write_entries`, `write_bytes`); only CPU and memory go into the baseline.
Settled escrows remove their record (ADR 0013), which is why `settle_many`
writes far fewer bytes than `create_escrows` stores.

The ten-releaser batch emits a bigger state event (the full releaser set)
while the fee batch spends more CPU on two token transfers and the callback,
so the fee + callback shape is the CPU worst case and the ten-releaser shape
is the events worst case; both stay under 80% of the events budget.
