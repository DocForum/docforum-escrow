Issue #344 (Phase E6): the Go client now exposes the contract's batch entry
points. `CreateEscrows` wraps `create_escrows` and `SettleMany` wraps
`settle_many`, both chunking at the contract's measured limits — exported as
`MaxBatchSize` = 16 and `MaxSettleOps` = 12, with comments pointing at
`contracts/escrow/src/constants.rs` (see ADR 0012). `settle_many`'s
`Vec<Result<(), Error>>` decodes into `[]SettleOpResult` in input order: a nil
`Err` means the op settled, and a rejection is the contract's typed
`*ContractError` with the escrow untouched. A chunk-level failure (a failing
payee callback reverting the transaction) is returned as the error while the
result keeps the earlier chunks that committed; `CreateEscrows` validates every
item before the first transaction. Encoding/decoding tests are offline and the
opt-in integration suite covers a two-item create plus a three-op settle with a
duplicate that reports `NotFunded`. No contract change.
