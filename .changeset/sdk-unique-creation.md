---
"@docforum/escrow-sdk": minor
---

Retry-safe escrow creation (issue #469; contract issue #47).

- `createEscrow({ ..., unique: true })` calls `create_escrow_with_uniqueness` with `create_escrow`'s exact arguments plus `unique_ref: true`. A `DuplicateConditionRef` at simulation or submission resolves to the existing escrow: `{ escrowId, txHash: undefined, existing: true, status }`. A new creation returns `existing: false`. The opt-in params type is `UniqueCreateEscrowParams` (`unique: true`); `CreateEscrowParams.unique` only accepts `false`, so anything typed `CreateEscrowParams` (including batch and milestone items) keeps the unchanged call and the unchanged `{ escrowId; txHash: string }` return type. `FakeEscrowClient` models the uniqueness index too.
- The recovered escrow's payee, token and amount are compared with the request while its record is readable. A mismatch throws the new `UniqueEscrowMismatchError` and is never reported as success. A settled duplicate (record reclaimed, index kept) returns its id and terminal `status` without the terms check.
- `unique` with `requiresAcceptance`, `releaseNotBefore` or quorum options throws a `TypeError` before anything is sent.
- `client.getUniqueEscrow(payer, conditionRef)` → `bigint | undefined`.
- New typed `DuplicateConditionRefError` (code 60).
