# ADR 0002: `release`/`refund` authorization is a per-escrow `releaser` set at `create_escrow` time

Status: Accepted

## Context

`release()` and `refund()` (Phase E2, issues #2/#3) need to restrict who
may call them — "a designated releaser identity/role," per both issues —
without the contract ever interpreting *why* release or refund is
warranted (ADR 0001: the contract enforces WHO, never WHY).

Two options were on the table:

1. **A contract-level admin**, set once at deployment, authorized to
   release/refund any escrow.
2. **A per-escrow `releaser` address**, supplied by the caller of
   `create_escrow` and stored alongside that escrow's data — authorized
   to release or refund *that specific escrow* only.

## Decision

Option 2: a `releaser: Address` field, set at `create_escrow` time,
stored in `EscrowData`. `release`/`refund` both require the caller to
equal that escrow's `releaser` — the same identity is trusted for both
actions on a given escrow, not two separate roles.

## Why

- **No single point of control.** A global admin is one key whose
  compromise or unavailability affects every escrow this contract will
  ever hold. A per-escrow releaser scopes the blast radius of a
  compromised or misbehaving releaser identity to the escrows it was
  actually assigned to.
- **Matches the real caller.** `docforum-core`'s `payments` module (the
  only intended caller per ADR 0001) is the system that actually knows
  when a `FulfillmentRecord` becomes `fulfilled` or `rejected` — it's
  the natural releaser for the escrows it creates. A global admin would
  just mean `docforum-core` passes its own address as "the admin" at
  deploy time anyway, with none of the scoping benefit.
- **Stays generic.** The contract still never inspects `condition_ref`
  or interprets domain meaning — it only records and later checks one
  `Address`. This is consistent with ADR 0001's "reusable beyond
  DocForum" goal: any consuming application decides its own releaser
  per escrow, with no DocForum-specific concept baked in.
- **Multi-tenant ready without extra work.** If this contract is ever
  reused by more than one consuming application (ADR 0001's stated
  goal), a global admin would force them to share one trusted identity.
  Per-escrow releasers need no such coordination.

## Consequences

- `create_escrow`'s signature gained a `releaser: Address` parameter —
  a breaking change from the Phase E1 signature already live on testnet
  (see `docs/testnet-deployments.md`, which remains an accurate record
  of that earlier deployment, not retroactively edited). Redeploying to
  testnet with the new signature is tracked separately, not part of
  this change.
- `release`/`refund` share one auth check (`caller == data.releaser`) —
  there's no separate "refunder" role. If a future use case genuinely
  needs different identities for release vs. refund, that's a new
  decision to make then, not assumed here.
