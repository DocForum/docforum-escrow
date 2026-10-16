# ADR 0009: Releaser rotation requires the current releaser and payer

Status: Accepted

## Context

ADR 0002 assigns one releaser to each escrow. A leaked releaser key can
settle funded escrows, but adding a rotation method authorized only by
that key would let its holder transfer control to an attacker. Leaving
the releaser immutable, however, offers no recovery when the key leaks.

## Decision

Allow rotation only while an escrow is `Funded`, and require authorization
from both the currently stored releaser and the stored payer. The caller
must be the current releaser. The replacement cannot be the escrow
contract itself or its payee. Rotation updates only the releaser field;
the payer, payee, token, amount, timeout and status remain unchanged. The
contract emits a `rotate` event keyed by escrow id with old and new
releaser addresses.

The payer's authorization is the recovery guard: possession of the old
releaser key alone is insufficient to appoint a new address. A rotation
does not add an administrator or change who may release/refund after the
rotation succeeds.

## Consequences

- The payer must remain available to approve recovery. If the payer key
  is lost, rotation is unavailable; the existing timeout refund path is
  still the recovery mechanism when configured.
- Rotation is unavailable after release or refund because there is no
  longer an active authorization role to change.
- Consumers should monitor the rotation event and record the replacement
  address alongside the escrow.

## Validation

Contract tests cover successful rotation, rejection of a caller other
than the current releaser, rejection after settlement, and rejection of
the contract/payee as the replacement.
