Issue #348 (Phase E6): the indexer now reads its network passphrase from
`DOCFORUM_NETWORK_PASSPHRASE` (testnet default) and keeps the existing
`DOCFORUM_HORIZON_URL` / `DOCFORUM_RPC_URL` overrides. The public passphrase
and public-network endpoints (`horizon.stellar.org`, `soroban.stellar.org`,
or a host labelled `mainnet`/`pubnet`) are refused unless
`DOCFORUM_ALLOW_MAINNET` is exactly `true`, mirroring the SDK's `allowMainnet`
guard; surrounding whitespace is trimmed so a padded passphrase cannot slip
past the check, and typos in either variable name fall back to testnet.
`tsconfig.json` marks `.ts` files as CommonJS for ts-node so `project.ts`
loads with its pinned CommonJS module setting. Documented local quickstart
configuration in `indexer/README.md`. No contract or SDK surface change.
