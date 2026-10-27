Issue #67 (Phase E6): added SDK network presets (`networks.testnet`,
`networks.futurenet`, `networks.local`) carrying an RPC URL, network
passphrase and known contract ids, plus an explicit mainnet opt-in guard:
constructing an `EscrowClient` with the mainnet passphrase throws
`MainnetNotAllowedError` unless `allowMainnet: true`. When a preset is
selected (or `verifyNetwork: true` is passed) the client verifies the RPC's
`getNetwork` passphrase lazily, once, before its first network call, and
throws `NetworkMismatchError` on a mismatch; it never runs in the
constructor, the result is cached per client and a failed check is not
cached. With a preset only, an RPC without `getNetwork` (an offline test
double) is skipped; an explicit request makes that an error, and
`verifyNetwork: false` turns the check off. Clients without a preset make no
extra requests. Custom networks still work, and plain-HTTP RPC (local
quickstart) needs `allowHttp`, which `networks.local` sets. No contract
change, so the generated bindings are unchanged.
