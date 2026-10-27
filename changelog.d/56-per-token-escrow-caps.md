Issue #56 (Phase E5): immutable per-token escrow caps for a guarded mainnet
beta. The constructor now takes `maximum_amounts: Map<Address, i128>` next to
`allowed_tokens`; an empty map keeps the uncapped behaviour, otherwise tokens
without an entry are rejected (`TokenCapNotConfigured = 36`) and any escrow
total above its token's cap fails with `AmountCapExceeded = 37` — on every
creation path including each batch item, on `top_up`, and on a pooled
escrow's funding target. Staged-launch plan in ADR 0013; `scripts/deploy`
gains `--maximum-amounts`. SDK bindings regenerated; every snapshot gains the
(empty) `MaximumAmounts` instance entry. Not yet deployed to testnet.
