---
"@docforum/escrow-sdk": minor
---

Add multisig releaser setup helpers (T1 mitigation): `buildMultisigSetup`,
`dryRunMultisigSetup`, `printMultisigDryRun`, `verifyMultisig`,
`readOnChainMultisig`, `validateMultisigPolicy`, `resolveMultisigPolicy`,
`MultisigLockOutError`, `MultisigValidationError`, `TESTNET_PASSPHRASE`,
`MIN_WEIGHT` and `MAX_WEIGHT`.

`buildMultisigSetup` emits a single atomic `setOptions` transaction and throws
on any lock-out configuration. No contract change; existing exports are
unchanged.
