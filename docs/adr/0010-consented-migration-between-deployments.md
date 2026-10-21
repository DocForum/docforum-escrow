# ADR 0010 — Consented migration between deployments

- **Status:** Accepted (2026-10-21)
- **Phase:** E5 — Migration protocol (issue #117)
- **Deciders:** contract maintainers
- **Related:** [ADR 0004](0004-timeout-refund-path.md), [ADR 0007](0007-in-contract-m-of-n-releaser-quorum.md), [ADR 0009](0009-sponsored-funding-refund-to.md)

## Context

Immutable deployments cannot retroactively gain an export function, so open escrows may become stranded on historical deployments. The repo's design rule is that the contract enforces who may act, never why; there is no privileged admin or upgrade path. A migration feature therefore must be explicit, consent-based, and scoped to a recognized source deployment.

The migration requirement is different from ordinary settlement:

- the escrow funds and its stored state must move between contracts atomically;
- the source escrow must remain non-spendable after export;
- different deployments may reuse the same numeric escrow ids;
- duplicated imports must be rejected;
- the escrow payer and at least the stored threshold of distinct releasers must authorize before the source hands over the funds.

## Decision

Add a consented export/import protocol that is valid only between deployments that mutually recognize each other in a fixed trusted-source list. The source deployment exposes `export_to(escrow_id, new_contract, approvers)`, the destination exposes `import_from(source_contract, migration_payload)`, and the contract treats the migration as a single atomic, authenticated transfer of both funds and escrow state.

### Storage and identity

Each escrow remains identified by its own deployment-local numeric id, but each migration is keyed by a deployment-wide pair:

```rust
pub struct MigrationKey {
    source_contract: Address,
    source_id: u64,
}
```

This ensures different source deployments with the same local id do not collide, and the same source escrow cannot be imported twice.

### Trusted source configuration

Each deployment stores an immutable allowlist of approved predecessor contracts at construction time:

```rust
__constructor(allowed_tokens: Vec<Address>, approved_sources: Vec<Address>)
```

The list is fixed for the contract lifecycle and there is no admin setter. The destination accepts imports only from an address present in this list. The source is trusted because the destination's own contract configuration includes it and the source contract proves it is the immediate caller via Soroban authentication. The destination does not read source storage during import: Soroban forbids that re-entry path. The allowlist therefore also explicitly trusts the approved source implementation to construct payloads from its own stored record and enforce payer and releaser consent.

### Protocol flow

1. The source escrow must be `Funded` and not already migrated.
2. The payer authorizes the source call to `export_to(escrow_id, new_contract, approvers)`.
3. At least the escrow's stored threshold of distinct releasers authorize the same source call; every supplied approver must belong to the stored releaser set.
4. The source builds a migration payload from its stored escrow record and includes its own contract address.
5. The source transfers the escrowed funds to the destination contract, then calls `import_from(source_contract, migration_payload)` synchronously.
6. The destination checks that `source_contract` is in its trusted predecessor list and is the authenticated caller.
7. The destination validates migration invariants in the payload, including funded status, amount, releaser set and threshold, and refund destination. The payload binds the destination's pre-transfer token balance; import requires the destination balance to increase by exactly the escrow amount.
8. The destination rejects duplicates using the `MigrationKey`, then creates an escrow record in `Funded` state and stores the key to prevent replay.
9. The source marks the original escrow as `Migrated` and prevents any later release or refund.

This is implemented as one logical Soroban transaction. If destination validation fails, the error propagates through `export_to` so the token transfer and all storage changes roll back together.

### Failure handling

Soroban rolls back all storage writes and token transfers for a failed contract call. The migration protocol therefore uses a single synchronous call chain and does not split the workflow across separate transactions or asynchronous jobs. If destination validation fails or the destination rejects the import, the source escrow remains `Funded` and no funds leave the source deployment.

### Compatibility

Existing immutable testnet deployments cannot participate because they have no `export_to` entry point and no migration-aware storage. Their escrow ids and contract addresses remain valid but are not recognized by a newer deployment unless that newer deployment explicitly allows them via the trusted-source set. The migration protocol therefore does not imply a retroactive upgrade of historical deployments, and integrators must continue to settle those old escrows on the original deployment until they are closed.

### Alternatives considered

- **Manual tracking only**: rejected because it leaves historical deployments as side-branches and reintroduces human error and stale escrow state.
- **Close and recreate**: rejected because it loses the original escrow record, resets the lifecycle, and can violate the intended settlement semantics.
- **Allow any contract to import arbitrary data**: rejected because the destination would accept fabricated escrows and create funded-looking records without real funds.
- **Accumulated migration approvals across calls**: rejected because it introduces partial state and replay risk; a single authenticated call is simpler and easier to reason about.

### Trade-offs

- **Administrative trust**: the destination must maintain and review its predecessor allowlist. That is the core operational trust boundary and is intentionally explicit rather than hidden.
- **Compatibility**: only deployments that add the migration entry points can participate; older deployments remain read-only historical states.
- **Operational complexity**: integrators need to track the source deployment id and maintain the allowlist as deployments are added.

## Consequences

- `EscrowStatus` gains `Migrated` to make the source escrow terminal and non-settleable.
- `__constructor` adds the predecessor allowlist and remains immutable, preserving the repo's no-admin rule.
- New contract functions are additive but not retroactive: only future deployments with the export/import protocol can use them.
- Existing matured historical escrows remain on their original deployment and are handled through the legacy release/refund flow until they settle naturally.

## References

- Issue #117.
- `docs/threat-model.md` and the repo's hard rules on no admin, no PHI, and testnet-only deployment.
