Issue #55 (Phase E5): `release` now uses `try_transfer` for the payout. If the
token rejects the transfer (for example a SAC payee whose trustline was
deauthorised, or a contract payee that rejects the funds), the call returns the
new append-only `Error::Undeliverable = 35` and the escrow stays `Funded` with
its balance intact, so the releaser can retry once the payee is reachable or
use the refund path. Refund transfers are unchanged. Tests in
`contracts/escrow/tests/undeliverable.rs`; generated SDK bindings regenerated
for the new error code.
