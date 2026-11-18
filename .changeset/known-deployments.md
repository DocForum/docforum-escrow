---
"@docforum/escrow-sdk": minor
---

Add known deployments per network (issue #89). `knownContractId(network)`,
`knownNetworkConfig(network)` and `latestDeployment(network)` resolve the newest
fully verified record written by `scripts/deploy`; `parseDeployments` validates
a `deployments.json` value. The records are bundled with the SDK, so no
filesystem access is needed. Unknown networks throw `UnknownDeploymentError`,
and mainnet always throws. Additive only.
