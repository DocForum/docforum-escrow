Issue #367 (Phase E4): documented the `settle_many` denial of service a
hostile `notify_payee` payee contract can trigger, with
`tests/settle_many.rs::hostile_callback_payee_reverts_a_batch_of_valid_releases`
plus tests for the mitigation and for refund ops staying batchable. The rule
is to settle `notify_payee` **release** ops one per transaction; refunds never
invoke the callback. No contract or SDK surface change, so no
`contract-changes.d/` fragment and the generated bindings are unchanged.
