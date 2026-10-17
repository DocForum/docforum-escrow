===

\# ADR 0005 - Reclaim storage for settled escrows



\- \*\*Status:\*\* Proposed

\- \*\*Date:\*\* 2026-10-16

\- \*\*Issue:\*\* \[#48](https://github.com/DocForum/docforum-escrow/issues/48)

\- \*\*Depends on:\*\* \[#9](https://github.com/DocForum/docforum-escrow/issues/9) - emitted in the same PR as a prerequisite.



\## Context



Every escrow is written to persistent storage under `DataKey::Escrow(id)` as an `EscrowData` struct containing `payer`, `payee`, `token`, `amount`, `condition\_ref`, `status`, `releaser` and `refund\_after`.



That record is created by `create\_escrow` and today is only ever updated by `release` / `refund`. The full record therefore stays in persistent storage forever, or until Soroban archives it (requires paying rent - see issue #10).



Once an escrow reaches `Released` or `Refunded`, almost all of that data is historical. The only thing any current caller needs to know is what happened to this id - a status. `payer` / `payee` / `token` / `amount` / `condition\_ref` / `releaser` / `refund\_after` are only relevant before settlement or for audit - and events are the correct place for audit history, not on-chain state paid for by rent.



\## Decision



Adopt a tombstone. On settlement, replace the `EscrowData` record with a minimal `SettledEscrow { status }` record under a new key, `DataKey::SettledEscrow(id)`, and remove `DataKey::Escrow(id)`.



\### Read contract for settled ids



\- `get\_status(id)` returns the tombstone's status (`Released` / `Refunded`), not `NotFound`. `NotFound` means never created; a status means settled.

\- `get\_escrow(id)` returns `Err(NotFound)` after settlement. The return type stays `Result<EscrowData, Error>`; we do not widen it.

\- `NextId` is never touched. Ids are monotonic and are never reused, before or after settlement.



\### Events (prerequisite)



The settlement event must be published before the `EscrowData` is removed, and it must carry everything a historian needs. Issue #9's events land first (same PR):



\- `EscrowCreated { escrow\_id, payer, payee, token, amount, condition\_ref, releaser, refund\_after }`

\- `EscrowReleased { escrow\_id, payer, payee, token, amount, condition\_ref, releaser }`

\- `EscrowRefunded { escrow\_id, payer, payee, token, amount, condition\_ref, caller }`



The event log, not on-chain state, is the audit source after settlement.



\## Alternatives considered



\### Alternative A - Delete on settlement (no tombstone)



Remove `DataKey::Escrow(id)` entirely. `get\_status` returns `Err(NotFound)`. Maximum rent reclaimed, but `NotFound` conflates never existed with settled. Rejected.



\### Alternative B - Keep everything (status quo)



Leave `EscrowData` forever. Zero change, but settled records pay rent forever. Rejected.



\### Alternative C - Separate settled-ledger, keep EscrowData too



Write both. Reclaims nothing. Rejected as strictly worse than A/B.



\## Consequences



\- Breaking change for integrators. `get\_escrow(id)` starts returning `NotFound` for settled ids. SDK `@docforum/escrow-sdk` is bumped \*\*0.3.0 -> 0.4.0\*\* (hard rule 3).

\- Events are mandatory. If #9's events are not in the same PR, this ADR must not be merged - losing history is worse than the rent cost.

\- Storage layout. A settled escrow is a single `SettledEscrow { status: EscrowStatus }` under `DataKey::SettledEscrow(id)`. The `EscrowData` entry is removed in the same transaction that performs the settlement transfer.

\- Id non-reuse. `NextId` is a monotonically-increasing instance counter; the `reclaim\_storage.rs` test verifies it explicitly after settlement.



\### Rent



Measured by a test in `contracts/escrow/tests/reclaim\_storage.rs` that records storage entry sizes before and after settlement; the test prints both sizes and the PR description includes the printed values.



\## References



\- Issue: https://github.com/DocForum/docforum-escrow/issues/48

\- Pre-requisite: https://github.com/DocForum/docforum-escrow/issues/9

\- TTL context: https://github.com/DocForum/docforum-escrow/issues/10

\- Threat model: docs/threat-model.md

\- Hard rules: ARCHITECTURE\_ESSENTIALS.md (1 no PHI; 2 tests for every contract change; 3 strict semver for SDK; 4 testnet only)

===

