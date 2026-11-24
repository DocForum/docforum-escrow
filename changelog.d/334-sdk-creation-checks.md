Issue #334 (Phase E6): the remaining creation rejections are now caught
offline, with the contract error name in the message. `createEscrow` and
`createQuorumEscrow` reject a non-positive `amount` (`InvalidAmount`, 2) and a
`refundTo` equal to the contract id (`InvalidRefundTo`, 21); `createEscrow`
also rejects `feeRecipient` equal to the contract id (`InvalidFee`, 35) and a
`releaseNotBefore` later than `refundAfter` (`InvalidReleaseNotBefore`, 22).
`createPooledEscrow`'s existing target/deadline checks now name `InvalidAmount`
and `InvalidFundingDeadline`. `createEscrows` inherits the checks because each
item goes through `createEscrow`. Clock-dependent orderings (a
`releaseNotBefore` already in the past) are deliberately not checked: only the
ledger knows that, and the contract decides. No contract change.
