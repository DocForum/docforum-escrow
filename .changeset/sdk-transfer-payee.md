---
"@docforum/escrow-sdk": minor
---

Add `EscrowClient.transferPayee({ escrowId, currentPayee, newPayee })` (issue #325, Phase E6), wrapping the contract's `transfer_payee` so a payee rotating wallets no longer builds the invocation by hand.

- Accepts a `Keypair` or SEP-43 signer for the current payee, like `topUp`/`accept`.
- Client-side preconditions mirror the contract in order: the signer must be the escrow's payee (`Unauthorized`), the escrow must be `Funded` (`NotFunded`), and `newPayee` must not be the payer or the contract id (`InvalidNewPayee`, contract error 37). Failures throw `EscrowPreconditionError` before any transaction is built.
- Added to `prepareLifecycleCall` as method `transfer_payee`, so the current payee can sign on another machine and a relayer can submit.
- JSDoc warns that on a `notifyPayee` escrow the new payee must implement the `notify_payee` callback.

Additive surface; no contract change and no breaking change.
