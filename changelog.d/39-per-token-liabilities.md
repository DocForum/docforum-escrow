Issue #39 (Phase E5): per-token liability accounting and an on-chain
solvency view. New read-only `solvency(token) -> (balance, liabilities)`;
`liabilities` is the sum of `amount` over every `Funded` escrow in that
token, kept in a new persistent `DataKey::Liability(token)` entry
(appended last, so existing storage encodings are unchanged) whose TTL is
re-extended on every write. The counter is increased in
`transfer_in_exact` (the single inbound path for every creation entry
point, `top_up` and `contribute`) and decreased in `settle()` and
`claim_refund`, always in the same invocation as the state change.
`tests/liabilities.rs`: 14 tests, including a proptest that runs random
sequences over every state-changing entry point and checks, after each
step, that liabilities equal the per-token sum of `Funded` amounts and the
contract balance. Monitoring guidance in `docs/threat-model.md`. Existing
test snapshots change only by the new `Liability` storage entry. SDK:
`client.getSolvency(token)` and regenerated bindings (minor). Not yet
deployed to testnet.
