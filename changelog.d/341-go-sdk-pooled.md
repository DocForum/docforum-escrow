Issue #341 (Phase E6): the Go client now wraps pooled escrows.
`CreatePooledEscrow` (`create_pooled_escrow`), `Contribute` (`contribute`),
`ClaimRefund` (`claim_refund`), `GetPooled` (`get_pooled`) and
`GetContribution` (`get_contribution`) are implemented with `PooledData` and
`Contribution` decoders built from the contract's own field names.
`GetContribution` models the contract's `Option<Contribution>` as
`*Contribution` (`nil` = never contributed) while `ErrNotFound` and
`ErrNotPooled` stay distinguishable, and contract codes 26–34 have named
sentinels. `Contribute` and `ClaimRefund` accept the contributor's signer per
call. Decoder and argument-XDR tests are offline; the opt-in integration suite
runs a failed round with two contributors and two claims. No contract change.
