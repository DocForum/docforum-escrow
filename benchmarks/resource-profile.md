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
