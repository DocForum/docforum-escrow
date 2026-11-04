---
"@docforum/escrow-sdk": minor
---

Check the contract version on first use (issue #52). Adds `getContractVersion()`, `verifyContractVersion()`, the `verifyContractVersion` client option, `isSupportedContractVersion`, `SUPPORTED_CONTRACT_VERSIONS` and `UnsupportedContractVersionError`. The automatic check runs only with `verifyContractVersion: true` or a `network` preset. With a preset, a contract outside `>=2.0.0 <3.0.0` now fails on first use instead of failing later with a confusing error. Older deployments with no `version()` are reported as `null`.
