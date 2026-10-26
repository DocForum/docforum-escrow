Issue #89 (Phase E7): added `scripts/deploy`, one command for deploy → verify
→ record. It builds or takes the WASM, checks its SHA-256, uploads and deploys
it with the constructor allowlist, confirms the on-chain WASM matches, runs a
scripted live verification (create, release, refund; stranger release, double
release and zero-amount rejections), and records the result in
`deployments.json`, `docs/testnet-deployments.md` and
`sdk/src/deployments.generated.ts`. It refuses a dirty git tree and any network
except testnet; `--dry-run` runs against a local quickstart without touching
tracked files. The SDK adds `knownContractId`, `knownNetworkConfig`,
`latestDeployment` and `parseDeployments` with no filesystem access, so it
still runs in browsers, Deno and Bun. No contract change.
