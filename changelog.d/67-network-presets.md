Issue #67 (Phase E6): added SDK network presets (`networks.testnet`,
`networks.futurenet`, `networks.local`) carrying an RPC URL, network
passphrase and known contract ids, plus an explicit mainnet opt-in guard:
constructing an `EscrowClient` with the mainnet passphrase throws
`MainnetNotAllowedError` unless `allowMainnet: true`. The first network call
verifies the RPC's `getNetwork` passphrase against the configured one and
throws `NetworkMismatchError` on a mismatch (on by default, cached per
client, a failed check is not cached), so a custom `rpcUrl` cannot bypass the
guard; `verifyNetwork: false` opts out for offline test doubles. Custom
networks still work, and plain-HTTP RPC (local quickstart) needs `allowHttp`,
which `networks.local` sets. No contract change, so the generated bindings
are unchanged.
