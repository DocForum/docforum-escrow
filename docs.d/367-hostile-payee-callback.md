---
file: docs/threat-model.md
section: T11 — Malicious or failing release callback · **Medium (payee opt-in)**
---
- **Batch amplification (issue #367):** a failing callback aborts the whole
  `settle_many` invocation, so one consenting payee contract that fails
  `on_escrow_released` on demand can revert every otherwise valid release in
  a batch. That is a cheap denial of service against other payees in the
  same batch, and during a T1 race-to-settle it costs the defender a round.
  The contract cannot report it per-op (the transfer and the `Released` write
  already happened); the mitigation is operational — settle `notify_payee`
  **release** ops one per transaction and keep them out of shared batches
  (docs/adr/0012, `docs/runbooks/releaser-compromise.md`). Refund ops never
  invoke the callback, so only releases need isolating.
  Tests: `tests/settle_many.rs::hostile_callback_payee_reverts_a_batch_of_valid_releases`,
  `::isolating_the_callback_escrow_lets_the_valid_releases_settle`,
  `::refund_ops_never_invoke_the_payee_callback`.
