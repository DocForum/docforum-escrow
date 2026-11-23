Issue #349 (Phase E7): `scripts/verify-deployment` now looks up the contract in
`deployments.json` and cross-checks the recorded `wasmHash` against both a
fresh source build and the fetched on-chain WASM, reporting all three hashes
and failing on any mismatch. It warns when the checkout is not the recorded
`gitSha` (even when the record has no hash), accepts
`--network testnet|futurenet|local` or `--network=NAME` (testnet default),
refuses mainnet, treats a missing `deployments.json` as an unrecorded id, and
still verifies an unrecorded id against the build with a warning. README
verification instructions are supplied via a `docs.d/` fragment.
