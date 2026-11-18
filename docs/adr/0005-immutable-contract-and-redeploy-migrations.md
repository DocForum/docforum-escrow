# ADR 0005: Keep escrow contracts immutable and redeploy for changes

- **Status:** Accepted
- **Date:** 2026-10-17
- **Decision owners:** DocForum escrow maintainers
- **Closes:** #34

## Context

The escrow contract has no administrator or upgrade entry point. A new
contract release therefore receives a new contract ID. Adding an upgrade
key would make every escrow depend on the security of that key and would
give its holder authority to replace code that enforces the fund-flow
invariants. A timelock would make changes observable, but it would not
remove that authority or guarantee that every payee can exit before an
upgrade executes.

The contract also has persistent per-escrow state. A future release may
change the layout or interpretation of that state. A generic migration
hook cannot prove that old records are safe to reinterpret, and a failed
migration could make existing escrows inaccessible.

## Decision

Keep deployed escrow WASM immutable. Do not add an admin-upgradeable
contract, a timelock, an upgrade multisig, or an on-chain storage migration
hook. Deploy new code under a new contract ID and let existing escrows
finish under the code that created them.

This preserves the current trust model: there is no privileged contract
administrator, and contract code cannot be changed after deployment. It
also avoids representing a redeployment as a migration of funds or state
that the contract cannot safely perform.

## Alternatives considered

1. **Single administrator with an immediate upgrade function.** Rejected:
   a leaked key could replace the rules for every escrow at once.
2. **Timelocked administrator or multisig.** Rejected for this release:
   a threshold and delay reduce some key risks but still introduce a
   privileged code-change path, operational recovery requirements, and
   an exit window the contract cannot guarantee for every payee.
3. **Immutable deployments with a redeployment procedure.** Accepted:
   it keeps the contract's no-admin model and makes the limits of state
   continuity explicit to integrators.

## Redeployment and migration procedure

1. Make and review the code change on a feature branch. Contract logic
   changes must include tests under `contracts/escrow/tests/`.
2. Build and deploy the new WASM to **testnet only**. Verify the new
   contract's behavior and record its contract ID, WASM hash, and test
   transactions in `docs/testnet-deployments.md`.
3. Update the integrator's configured contract ID only for new escrows.
   Keep the previous ID and SDK client configuration available while it
   has funded escrows.
4. Settle each old escrow through its existing `release` or `refund`
   rules. A new contract cannot read or migrate the old contract's
   storage. Any new escrow must be funded through the normal
   `create_escrow` call with fresh authorization.
5. Retire an old contract ID from new writes only after the integrator
   has reconciled and settled its funded records. Keep read access and
   deployment history for auditability.

Do not ask an administrator or deployer to move funds out of an old
contract: no such privileged path exists. Existing escrows remain subject
to their stored parties, releaser, timeout, and the old contract code.

## Consequences

- A release that changes contract behavior requires a new contract ID.
- Integrators must track which contract ID owns each escrow and retain
  access to old deployments until their escrows settle.
- State layout changes do not require or permit an in-place migration.
- This decision does not authorize mainnet use. The independent security
  review in Phase E4 remains a prerequisite.

## Revisit conditions

Reconsider only after an independent security review identifies a concrete
recovery or upgrade need that cannot be met by immutable deployments, and
defines a threat-reviewed authorization and migration model. Any reversal
requires a new ADR and a separate review; it must not silently change this
decision.
