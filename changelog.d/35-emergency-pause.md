Issue #35 (Phase E5): deposit-only emergency pause. The contract's
`__constructor` now also takes a `pause_admin` address; only that custodian
can call `pause`/`unpause`, and while paused every deposit path fails with
`Paused` before any funds move — including pooled `create_pooled_escrow`
and `contribute` (`Paused`, plus `AlreadyPaused`/`NotPaused` for the
transition guards — provisional codes 3500–3502, renumbered by the
maintainer fold). `release`, `refund`, the timeout refund and pooled
`claim_refund` never read the flag, so a
pause can stop new exposure but never lock escrowed funds (invariant I8,
threat model T12, `docs/adr/0011`). The SDK gains `pause`/`unpause`/
`isPaused`/`getPauseAdmin` (minor changeset) and regenerated bindings. This
is a deployment change: the live testnet contract predates the constructor
and cannot pause until it is redeployed.
