`create_escrows` now works for batches of more than one item, and stays atomic.
`MAX_BATCH_SIZE` drops from 50 to 16 in the contract and the SDK, because 24
items exceed Mainnet's contract events limit. See the amended consequences in
`docs/adr/0012-batch-settlement-best-effort.md`.
