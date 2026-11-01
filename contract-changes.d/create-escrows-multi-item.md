bump: patch
---
`create_escrows` now works for more than one item: `payer` authorizes once for
the whole batch instead of once per item, which aborted with
`Error(Auth, ExistingValue)`. `MAX_BATCH_SIZE` drops from 50 to 16, because 24
items already exceed Mainnet's 16,384-byte contract events limit (docs/adr/0012).
