---
"@docforum/escrow-sdk": minor
---

Add network presets with an explicit mainnet opt-in guard (Phase E6, issue #67).

- `networks.testnet`, `networks.futurenet` and `networks.local` presets bundle
  an RPC URL, network passphrase and known contract ids; pass one as
  `network`. Explicit `rpcUrl` / `networkPassphrase` still win, so custom
  networks (private quickstart) keep working.
- Constructing an `EscrowClient` with the mainnet passphrase
  (`MAINNET_NETWORK_PASSPHRASE`) throws `MainnetNotAllowedError` unless
  `allowMainnet: true` is passed. Mainnet is not a preset.
- The first network call verifies the RPC's `getNetwork` passphrase against
  the configured one and throws `NetworkMismatchError` on a mismatch. The
  result is cached per client (a failure is not cached). On by default;
  `verifyNetwork: false` opts out, and `verifyNetwork()` checks on demand.
- New `allowHttp` option for plain-HTTP RPC endpoints; `networks.local` sets it.

Behaviour note: existing clients now make one `getNetwork` request before
their first network call.
