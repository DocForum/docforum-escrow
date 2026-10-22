# E7 — Manual testnet deployment workflow

Added a `manual-dispatch` GitHub Actions workflow that runs the testnet deploy script from a selected ref and opens a PR with the updated deployment record.

- Workflow dispatch inputs for ref and optional deploy notes.
- Dedicated testnet deployer secret scoped to a protected environment with required reviewers.
- Minimal `permissions:` with SHA-pinned actions and a concurrency group that prevents parallel deploys.
- Fails clearly when Friendbot or RPC is unavailable.
- On success, opens a PR updating `docs/testnet-deployments.md` and `deployments.json`.
