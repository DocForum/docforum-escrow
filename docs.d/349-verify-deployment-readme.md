---
file: README.md
section: Verify this deployment
---
The verifier also looks up the contract in `deployments.json` and prints the
recorded `wasmHash` next to the local build and on-chain hashes. All three
must agree; a missing record or a checkout that is not the recorded `gitSha`
is a warning, so an older deployment can still be checked. Pass
`--network testnet|futurenet|local` (or `--network=local`; testnet is the
default) and mainnet is refused until the security review. For a local
quickstart, set `LOCAL_RPC_URL` if it is not the default
`http://localhost:8000/rpc`.
