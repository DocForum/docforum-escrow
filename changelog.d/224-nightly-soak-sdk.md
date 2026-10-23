Issue #224: fixed the nightly testnet soak failures in the TypeScript SDK.
`authorizeRelease`, `authorizeRefund` and `submitRelayed` were documented in
the README but never implemented; they now simulate the settlement, collect
only the releaser's short-lived auth entry, and let a separate relayer sign the
envelope and submit it. `getEscrow` now falls back to decoding `get_escrow` by
field name when the generated positional decoder meets a testnet deployment
that predates a newer `EscrowData` field such as `release_not_before`. Added
offline coverage in `sdk/tests/relayed.test.ts` and
`sdk/tests/escrow-data.test.ts`, and wired both into `npm run test:offline`.
No contract change; the generated bindings are unchanged.
