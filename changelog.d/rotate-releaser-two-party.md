# Changelog fragment: SDK `rotateReleaser` with two-party authorization

## Added

- SDK: `prepareRotateReleaser(...)` builds a simulated `rotate_releaser` transaction and returns the two authorization entries (current releaser and payer) that must be signed. When payer == releaser, only one entry is returned.
- SDK: `signRotationAuth(...)` lets each party sign only its own authorization entry, so neither signature covers more than the single `rotate_releaser` invocation.
- SDK: `submitRotation(...)` submits the collected signed entries; the submitter needs neither party's key.
- SDK: client-side checks before preparing a rotation: the escrow is single-releaser, the escrow is `Funded`, and the new releaser is neither the payee nor the contract address.
- SDK: the authorization expiration ledger is exposed, and expired authorization is detected and reported clearly before submit.

## Notes

- No breaking change to the public contract surface. Contract `CONTRACT_VERSION` is unchanged.
- Relayed-auth handling is reused from `authorizeSettlement`.
