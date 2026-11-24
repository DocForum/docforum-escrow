# Escrow interface example

This example shows a Soroban contract using `docforum-escrow-interface` to
create and release an escrow through a nested contract call.

The calling contract must arrange authorization for the nested call. In this
example the externally authorized `caller` is both payer and releaser, so the
escrow's `require_auth` checks are satisfied by the same authorization tree.
Production integrations should choose their payer and releaser deliberately:
the escrow contract enforces who may act, not why.

Run the focused example test with:

```bash
cargo test --manifest-path contracts/examples/escrow-interface/Cargo.toml
```
