# Token conformance suite

`contracts/escrow/tests/token_conformance.rs` runs one set of escrow lifecycle
scenarios (create, release, refund, split settle, top-up, protocol fee, timeout
refund, cancel, `settle_many`, shared contract balance, underfunded payer)
against every token kind below. Adding a kind to the `conformance!` macro runs
it through every scenario.

| kind | decimals | notes |
| --- | --- | --- |
| native XLM SAC | 7 | payer must be a classic account (balance lives in the account entry); contracts hold balances in contract data |
| issued-asset SAC | 7 | no issuer flags set |
| custom SEP-41 (`ReferenceToken`) | 0, 6, 18 | covers decimals other than 7 |

Out of scope: issuer flags (clawback, auth required), fee-on-transfer and
malicious tokens (see `malicious_token.rs` and `token_allowlist.rs`).

Run: `cargo test --manifest-path contracts/escrow/Cargo.toml --test token_conformance`
