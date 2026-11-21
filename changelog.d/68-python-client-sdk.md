Issue #68 (Phase E6): added a Python client SDK in `sdk-python/` (package
`docforum_escrow`, `stellar-sdk` 17, Python 3.10+). It wraps `create_escrow`,
`get_status`, `get_escrow`, `release` and `refund` with a thin hand-written
client whose arguments are checked against `contract-spec.json` in the unit
tests. Contract errors are typed, one class per code, named like the TS SDK's
and checked against `contract-spec.json`, `errors.rs` and the TS generated
map. i128 amounts are Python `int` with range checks. Offline unit tests run
in the new `.github/workflows/sdk-python.yml`; the live testnet suite
(`ESCROW_INTEGRATION=1 pytest -m integration`) stays out of CI like the TS
SDK's. No PyPI publish yet: the plan is in `sdk-python/README.md`. No
contract change.
