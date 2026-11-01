Nightly soak: failures are now classified correctly. The old check matched bare
words such as "network", which `tests/network-presets.test.ts` always printed,
so every failure was reported as `INFRASTRUCTURE_FAILURE`. Added a
`DEPLOYMENT_OUTDATED` result for a contract whose function arguments no longer
match the SDK. The live suite now reads its contract id from `deployments.json`
through `knownContractId("testnet")`, or from `TESTNET_CONTRACT_ID`.
