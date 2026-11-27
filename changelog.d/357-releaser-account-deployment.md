Issue #357 (Phase E7): added `scripts/deploy-releaser-account`, which deploys
the optional M-of-N releaser custom account from a validated JSON config,
reads every constructor argument back from the contract and fails on any
mismatch, confirms the on-chain WASM hash, and records the deployment in
`releaser-account-deployments.json`. Mainnet is refused and `--dry-run` targets
a local quickstart. `scripts/releaser-account-config.mjs` validates the config
before any network call (public keys only, no secrets) and defines the config
hash. No contract or SDK surface changed.
