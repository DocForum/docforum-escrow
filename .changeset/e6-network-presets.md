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
- Network verification: when a `network` preset is selected (or
  `verifyNetwork: true` is passed), the client checks the RPC's `getNetwork`
  passphrase against the configured one lazily, once, before its first
  network call, and throws `NetworkMismatchError` on a mismatch. It never
  runs during construction. The result is cached per client (a failure is
  not cached). With a preset only, an RPC without `getNetwork` is skipped;
  with `verifyNetwork: true` (or `client.verifyNetwork()` on demand) it is an
  error. `verifyNetwork: false` turns the automatic check off. Pass
  `verifyNetwork: true` with a custom `rpcUrl` to guard it too.
- New `allowHttp` option for plain-HTTP RPC endpoints; `networks.local` sets it.

Behaviour note: existing clients that select no preset make no extra
requests; their behaviour is unchanged.
