Issue #110 (Phase E7): added the `Futurenet compatibility checks` workflow
(`.github/workflows/futurenet-compatibility.yml`) — manual `workflow_dispatch`
plus a weekly schedule, never on `pull_request`, so PRs are never blocked on
futurenet. It builds the current WASM, installs the Stellar CLI pinned in
`scripts/stellar-cli-version` (release tarball, sha256 verified), deploys to
futurenet with a generated identity, and runs the futurenet SDK integration
suite (`npm run test:futurenet`, scoped by `sdk/vitest.futurenet.config.ts`).
Futurenet resets are handled gracefully, and per-protocol reports live under
`docs/futurenet-compatibility-reports/`. No contract or SDK surface change.
