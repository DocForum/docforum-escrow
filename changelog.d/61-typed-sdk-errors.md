Issue #61 (Phase E6): the SDK now surfaces failures as typed `EscrowError`
subclasses. Contract rejections carry their numeric `code` and a named class
(`NotFoundError`, `UnauthorizedError`, `NotFundedError`, …); codes without a
dedicated class fall back to a generic `ContractError`. Simulation,
submission, timeout and network-passphrase mismatch failures have separate
classes, and the original exception is kept as `cause`. The code→name
mapping in `sdk/src/contract-errors.generated.ts` is generated from the Rust
`Error` enum and checked for drift in CI. Consumer migration notes live in
`docs/sdk-errors.md`.
