# ADR 0005: Optional release callback for contract payees

**Status:** Accepted for issue #53 (Phase E5).

## Context

A contract payee may need a synchronous signal when an escrow pays it. Polling
the escrow's public state is possible, but it does not let the payee act during
the release transaction. A callback adds a contract-to-contract call, so the
release path must remain safe against re-entry and callback failures.

## Decision

`create_escrow` gains a `notify_payee: bool` opt-in, stored with the escrow.
When true, `release` invokes the payee's
`on_escrow_released(escrow_id: u64, amount: i128)` after the token transfer.
The payee must be a contract implementing that method. With opt-in false (the
default in the SDK), no callback is made. The contract does not probe whether
an address is a contract during creation; an opted-in address without a
callable hook causes release to fail.

Release uses checks-effects-interactions: it stores `Released` before the
transfer and callback. Soroban transaction atomicity means any failed transfer
or callback rolls back the status and transfer. Callback errors are surfaced
as `CallbackFailed`; callback failure does not silently report a successful
release. A payee can therefore prevent its own opted-in release from
completing, but it cannot prevent `refund`: refund never calls the payee, and
the releaser can refund at any time (or anyone can refund after `refund_after`).

The callback is one synchronous invocation with two fixed scalar arguments.
The escrow does not loop, retry, or make nested callbacks. Soroban transaction
resource limits bound its CPU and memory use; if callback execution exceeds
the transaction budget, the release transaction fails atomically. Integrators
should keep hooks bounded and avoid unrelated work in the callback.

The callback cannot re-enter the escrow's `release`, `refund`, or
`create_escrow` while the escrow contract is on the call stack: the Soroban
host rejects contract re-entry. Tests pin this behavior. The status update
before both external interactions remains defense in depth and makes the
state transition explicit.

## Consequences

- `create_escrow` and `EscrowData` change, so generated bindings and the SDK
  must be updated. The SDK exposes `notifyPayee?: boolean`, defaulting to
  false. SDK version `0.3.0` becomes `0.4.0` because the generated contract
  client must target the new `create_escrow` signature; existing callers can
  omit the new option. Do not publish or deploy until the matching contract
  is deployed and verified on testnet.
- An opted-in callback failure leaves the escrow funded and its funds held;
  the releaser can refund it or the timeout path can recover it. This makes
  callback failure visible without giving the payee control over refunds.
- This change is testnet-only until the independent security review required
  by Phase E4 is complete.
