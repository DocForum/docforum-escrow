---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] SDK retry-safe creation (issue #469): `createEscrow({ unique: true })`
  through `create_escrow_with_uniqueness`, recovering a `DuplicateConditionRef`
  as `{ existing: true }` after a payee/token/amount check
  (`UniqueEscrowMismatchError` on a mismatch), and `getUniqueEscrow`. The
  non-unique path is unchanged. SDK only.
