# Soroban resource profile

Reproduce with `cargo bench --bench resource_profile` from
`contracts/escrow/`. The harness resets the Soroban budget tracker after
fixture setup and records CPU instructions and memory for one representative
successful call. Each call uses a fresh environment, a one-address releaser
set, a 100-unit escrow, and the same short condition reference. These native
host measurements compare this source with its parent revision; they are not
ledger fee quotes.

The before values were measured from the parent revision and the after values
from this branch. `benchmarks/baseline.json` contains the raw measurements.

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
write. `get_status` now reads only the compact status enum, cutting its
measured CPU and memory by 41% and 52%. `get_escrow` still reads the full
record because it returns that record to callers.

Moving `NextId` to a persistent entry was measured separately and increased
creation costs further, so that candidate was rejected and `NextId` remains
in instance storage.

The status index trades more writes and one persistent entry per escrow for a
substantially cheaper status read. The contract behavior and public API are
unchanged. The added storage key is a layout change: per ADR 0005, deploy new
WASM under a new testnet contract ID and let existing escrows settle under
their original contract.
