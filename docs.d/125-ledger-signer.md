Issue #125 documentation fragment: add the Ledger signer entry point
`@docforum/escrow-sdk/signers/ledger` to the SDK documentation and describe
that it signs transaction envelopes and Soroban authorization preimages via an
injected Ledger Stellar app. The `@ledgerhq/hw-app-str` package and its
WebHID/Node HID transport are optional; disabled hash signing is reported and
software signing is never used as a fallback. See `docs/ledger-signer.md` for
the manual test checklist.
