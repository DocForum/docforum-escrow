---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] Robust transaction lifecycle (issue #62): `EscrowClientConfig.transaction`
  (and a per-call `SubmitSignedOptions.transaction`) sets simulate, send and
  confirm timeouts plus a `TRY_AGAIN_LATER` budget. `submitSigned` reports the
  hash through `onTransactionHash` before sending, resends only the same
  envelope on `TRY_AGAIN_LATER`, never resends after a send timeout, and on a
  confirm timeout looks the hash up instead of resubmitting
  (`TransactionPendingError` when the outcome is still unknown). Fake-RPC
  tests in `sdk/tests/transaction-lifecycle.test.ts`.
