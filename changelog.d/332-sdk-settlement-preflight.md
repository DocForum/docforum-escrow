Issue #332 (Phase E6): added `canRelease` and `canRefund` to the SDK. Both
return `{ ok, reasons }` from the escrow, an optional pooled funding config,
the caller and the ledger clock, mirroring `release_checks`, `refund_checks`
and the payee-voluntary refund path in the contract's order, so `reasons[0]` is
the error the contract would return. `release`/`refund` accept
`{ checkPreconditions: true }` to throw `EscrowPreconditionError` before
simulating; the default stays off, because the contract is the authority and a
passing check can still fail on-chain. Additive SDK surface; no contract
change, so the generated bindings are unchanged.
