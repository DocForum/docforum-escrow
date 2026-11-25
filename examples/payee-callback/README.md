# Example payee contract: `on_escrow_released` callback

This crate is a small, documented example of a contract payee implementing the
`on_escrow_released(escrow_id, amount)` release callback defined in
[ADR 0005](../../docs/adr/0005-release-callback.md). It is intended to be
copied and adapted by integrators who want a contract payee to react
synchronously when an escrow pays it.

## What it does

`PayeeCallback` exposes `on_escrow_released(escrow_id, amount)`:

- It **records** each payout (`last_payout`, `total_received`).
- It **rejects unknown escrows** (`UnknownEscrow`) unless the escrow id was
  registered first with `register_escrow`.
- It supports a `reject` mode (`set_reject`) that makes the hook fail with
  `Rejected`, which reverts the release atomically — useful for testing
  failure handling.

## How an escrow triggers it

Create the escrow with `notify_payee: true` and the payee set to this
contract's address. On `release`, after the token transfer, the escrow
contract invokes `payee.on_escrow_released(escrow_id, amount)` where `amount`
is the amount paid to the payee **net of any protocol fee**.

The payee must authorize creation (the escrow contract requires the payee's
signature when `notify_payee` is true).

## Failure semantics

The callback runs inside the release transaction. If the hook returns an
error, the whole release reverts atomically:

- the escrow stays `Funded`;
- the payee receives nothing;
- the releaser can retry, or use the `refund` path (which never calls the
  payee) to recover the funds.

Gas budget: the hook is a single synchronous contract call. It must be bounded
and avoid unbounded work, since it counts against the transaction's CPU/memory
budget; exceeding it fails the release atomically.

## Tests

```
cargo test
```

Covers: the happy-path callback, the net-of-fee amount, a failing hook
reverting the release (while refund still works), and rejection of unknown
escrows.

## See also

- `contracts/escrow/tests/release_callback.rs` — the contract's own tests for
  the callback (including re-entry protection).
- `docs/adr/0005-release-callback.md` — the callback design.
