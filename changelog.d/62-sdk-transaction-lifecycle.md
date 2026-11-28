Issue #62 (Phase E6): `@docforum/escrow-sdk` owns the transaction lifecycle for
`submitSigned` and the `prepare*` methods. New `TransactionLifecycleOptions`
(`simulateTimeoutMs`, `sendTimeoutMs`, `confirmTimeoutMs`,
`maxTryAgainLaterAttempts`, `tryAgainLaterBackoffMs`) on
`EscrowClientConfig.transaction` or per call; `onTransactionHash` fires before
the send so the hash can be persisted; `TRY_AGAIN_LATER` resends the same
envelope with exponential backoff (`TryAgainLaterExhaustedError` past the
budget); a confirm timeout is settled by a lookup by hash, so a transaction
that lands after the timeout is reported as success and never resubmitted
(`TransactionPendingError` carries the hash otherwise; on-chain failure is
`TransactionFailedError`). No contract change, bindings unchanged.
